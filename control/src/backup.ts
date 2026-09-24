// Encrypted off-VM backups of the credit ledger (control.db).
//
// Every interval the ledger is copied with SQLite's online backup, gzipped and
// sealed with AES-256-GCM under a key derived from the dstack KMS key for this
// app, then uploaded to S3-compatible storage as <prefix><UTC time>.db.gz.enc.
// A snapshot identical to the last one uploaded is skipped. Only a VM of this
// app can decrypt a backup; the storage provider sees ciphertext, sizes and
// times. The object's name is authenticated with it, so an older backup cannot
// pass as a newer one.
//
// Restore runs at start, before the ledger opens, and only when the ledger file
// does not exist: the newest backup, or the one `restoreKey` pins. If backups
// are configured but cannot be listed or opened, start fails instead of opening
// an empty ledger. To restore over an existing ledger, point dbPath at a new file.
// When the ledger exists, start instead checks that the newest copy still opens
// with this VM's key, so every boot rehearses a restore.
//
// What a restore loses: usage billed and keys issued after the backup. Deposits
// are not lost: the chain cursor comes back with the ledger, and the deposit
// watcher credits every later deposit again from the chain.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { dstackKey } from './dstack.ts';
import type { S3Client } from './s3.ts';

const MAGIC = Buffer.from('ENVLDG01');
const NAME = /^(\d{8}T\d{9}Z)\.db\.gz\.enc$/;
const DAY_MS = 86_400_000;

export const KMS_PATH = 'envolvr/control/ledger-backup';

/** The backup key: HKDF over the app's dstack KMS key for KMS_PATH. */
export async function ledgerBackupKey(dstackEndpoint: string): Promise<Buffer> {
  const ikm = await dstackKey(dstackEndpoint, KMS_PATH, 'encryption');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'envolvr control.db backup v1', 32));
}

export function objectName(at: Date): string {
  return `${at.toISOString().replace(/[-:.]/g, '')}.db.gz.enc`;
}

function nameTime(name: string): number | undefined {
  const s = NAME.exec(name)?.[1];
  if (!s) return undefined;
  return Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.${s.slice(15, 18)}Z`);
}

const baseName = (key: string) => key.slice(key.lastIndexOf('/') + 1);

export function seal(key: Buffer, name: string, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.concat([MAGIC, Buffer.from(name)]));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

export function open(key: Buffer, name: string, sealed: Buffer): Buffer {
  if (sealed.length < MAGIC.length + 28 || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`${name}: not a ledger backup`);
  }
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + 12);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.concat([MAGIC, Buffer.from(name)]));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + 12, sealed.length - 16)), decipher.final()]);
  } catch {
    throw new Error(`${name}: authentication failed (wrong key, or the backup or its name was altered)`);
  }
}

type Log = (msg: string, fields?: Record<string, unknown>) => void;

export interface BackupOptions {
  /** Object key prefix, e.g. "control-db/". */
  prefix: string;
  /** Backups older than this are pruned (the newest `keepLatest` never are). */
  retainDays: number;
  keepLatest: number;
  now: () => Date;
  log: Log;
}

export class LedgerBackups {
  private s3: S3Client;
  private key: Buffer;
  private opts: BackupOptions;
  private lastHash: string | undefined;
  private lastPrune = 0;
  private running: Promise<unknown> = Promise.resolve();

  constructor(s3: S3Client, key: Buffer, opts: Partial<BackupOptions> & { prefix: string }) {
    this.s3 = s3;
    this.key = key;
    this.opts = {
      prefix: opts.prefix,
      retainDays: opts.retainDays ?? 30,
      keepLatest: opts.keepLatest ?? 24,
      now: opts.now ?? (() => new Date()),
      log: opts.log ?? (() => {}),
    };
  }

  /** Our backups under the prefix, oldest first. Other objects are ignored. */
  async list(): Promise<{ key: string; time: number }[]> {
    return (await this.s3.list(this.opts.prefix))
      .map((o) => ({ key: o.key, time: nameTime(baseName(o.key)) }))
      .filter((o): o is { key: string; time: number } => o.key.startsWith(this.opts.prefix) && o.time !== undefined);
  }

  /**
   * Restore into `dbPath`, which must not exist. Returns the object restored, or
   * null when there is no backup yet.
   */
  async restore(dbPath: string, pinned?: string): Promise<string | null> {
    const all = await this.list();
    const target = pinned ? all.find((o) => o.key === pinned || baseName(o.key) === pinned) : all.at(-1);
    if (pinned && !target) throw new Error(`backup ${pinned} not found under ${this.opts.prefix}`);
    if (!target) return null;
    const tmp = `${dbPath}.restore`;
    try {
      const plain = await this.fetchChecked(target.key, tmp);
      await rm(`${dbPath}-wal`, { force: true });
      await rm(`${dbPath}-shm`, { force: true });
      await rename(tmp, dbPath);
      this.lastHash = createHash('sha256').update(plain).digest('hex');
    } catch (err) {
      await rm(tmp, { force: true });
      throw new Error(`restore ${target.key}: ${(err as Error).message}`);
    }
    this.opts.log('ledger restored', { backup: target.key });
    return target.key;
  }

  /**
   * Check that the newest backup opens with this key and passes an integrity
   * check, without touching the ledger. Returns the object checked, or null.
   * Serialized with backups, so one started first checks the previous copy.
   */
  verifyLatest(dbPath: string): Promise<string | null> {
    return this.serial(() => this.verify(dbPath));
  }

  private async verify(dbPath: string): Promise<string | null> {
    const target = (await this.list()).at(-1);
    if (!target) return null;
    const tmp = `${dbPath}.verify`;
    try {
      const plain = await this.fetchChecked(target.key, tmp);
      this.lastHash = createHash('sha256').update(plain).digest('hex');
    } catch (err) {
      throw new Error(`verify ${target.key}: ${(err as Error).message}`);
    } finally {
      await rm(tmp, { force: true });
    }
    return target.key;
  }

  /** Download, decrypt and unpack one backup to `tmp`, then check it is a sound ledger. */
  private async fetchChecked(key: string, tmp: string): Promise<Buffer> {
    const plain = await promisify(gunzip)(open(this.key, baseName(key), await this.s3.get(key)));
    await writeFile(tmp, plain, { mode: 0o600 });
    const db = new DatabaseSync(tmp, { readOnly: true });
    try {
      const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error(`integrity check: ${check.integrity_check}`);
      db.prepare('SELECT count(*) FROM accounts').get();
    } finally {
      db.close();
    }
    return plain;
  }

  /** Snapshot and upload now, unless nothing changed. Serialized with other runs. */
  backupOnce(db: DatabaseSync, dbPath: string): Promise<string | null> {
    return this.serial(() => this.upload(db, dbPath));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.running.then(fn);
    this.running = run.catch(() => {});
    return run;
  }

  private async upload(db: DatabaseSync, dbPath: string): Promise<string | null> {
    const tmp = `${dbPath}.snapshot`;
    await rm(tmp, { force: true });
    let plain: Buffer;
    try {
      await backup(db, tmp);
      plain = await readFile(tmp);
    } finally {
      await rm(tmp, { force: true });
    }
    const hash = createHash('sha256').update(plain).digest('hex');
    if (hash === this.lastHash) return null;
    const now = this.opts.now();
    const name = objectName(now);
    const sealed = seal(this.key, name, await promisify(gzip)(plain));
    await this.s3.put(this.opts.prefix + name, sealed);
    this.lastHash = hash;
    this.opts.log('ledger backed up', { backup: this.opts.prefix + name, bytes: sealed.length });
    if (now.getTime() - this.lastPrune >= DAY_MS) {
      this.lastPrune = now.getTime();
      await this.prune().catch((err) => this.opts.log('ledger backup prune failed', { error: String(err) }));
    }
    return this.opts.prefix + name;
  }

  /** Delete backups past the retention window, keeping the newest `keepLatest`. */
  async prune(): Promise<string[]> {
    const cutoff = this.opts.now().getTime() - this.opts.retainDays * DAY_MS;
    const all = await this.list();
    const old = all.slice(0, Math.max(0, all.length - this.opts.keepLatest)).filter((o) => o.time < cutoff);
    for (const o of old) await this.s3.delete(o.key);
    if (old.length) this.opts.log('ledger backups pruned', { deleted: old.length });
    return old.map((o) => o.key);
  }

  /**
   * Back up every `intervalMs`. The returned stop function ends the loop and
   * takes a final backup, so a clean shutdown loses nothing.
   */
  start(db: DatabaseSync, dbPath: string, intervalMs: number): () => Promise<void> {
    const tick = () => this.backupOnce(db, dbPath)
      .catch((err) => this.opts.log('ledger backup failed', { error: String(err) }));
    const timer = setInterval(tick, intervalMs);
    void tick();
    return async () => {
      clearInterval(timer);
      await tick();
    };
  }
}
