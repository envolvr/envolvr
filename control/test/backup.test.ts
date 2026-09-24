import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerBackups, ledgerBackupKey, objectName, open, seal } from '../src/backup.ts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { dstackKey } from '../src/dstack.ts';
import { S3Client, signV4 } from '../src/s3.ts';

// AWS's worked SigV4 example (IAM ListUsers, 2015-08-30).
test('signV4 matches the AWS reference signature', () => {
  const auth = signV4({
    method: 'GET', path: '/', query: { Action: 'ListUsers', Version: '2010-05-08' },
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      Host: 'iam.amazonaws.com',
      'X-Amz-Date': '20150830T123600Z',
    },
    payloadHash: createHash('sha256').update('').digest('hex'),
    region: 'us-east-1', service: 'iam',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  });
  assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, '
    + 'SignedHeaders=content-type;host;x-amz-date, '
    + 'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
});

// An in-memory S3 that re-derives each signature from the request as received,
// so a mismatch between what the client signs and what it sends fails here.
const CREDS = { accessKeyId: 'test-key', secretAccessKey: 'test-secret' };
const objects = new Map<string, Buffer>();
let requests: string[] = [];
let s3Server: Server;
let endpoint: string;

before(async () => {
  s3Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, 'http://x');
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const signed = /SignedHeaders=([^,]+)/.exec(req.headers.authorization ?? '')?.[1]?.split(';') ?? [];
    const expected = signV4({
      method: req.method!, path: url.pathname, query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(signed.map((h) => [h, String(req.headers[h])])),
      payloadHash, region: 'auto', service: 's3', ...CREDS,
    });
    if (req.headers.authorization !== expected || req.headers['x-amz-content-sha256'] !== payloadHash) {
      res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }
    requests.push(`${req.method} ${decodeURIComponent(url.pathname)}`);
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    if (bucket !== 'ledger') return void res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>');
    if (req.method === 'PUT') objects.set(key, body);
    else if (req.method === 'DELETE') objects.delete(key);
    else if (req.method === 'GET' && key) {
      const obj = objects.get(key);
      return void (obj ? res.writeHead(200).end(obj) : res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'));
    } else if (req.method === 'GET') {
      // Two keys per page, to exercise continuation.
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get('continuation-token') ?? 0);
      const page = keys.slice(start, start + 2);
      const more = start + 2 < keys.length;
      res.writeHead(200).end(`<ListBucketResult>${page.map((k) =>
        `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${objects.get(k)!.length}</Size></Contents>`).join('')}`
        + `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}`
        + '</ListBucketResult>');
      return;
    }
    res.writeHead(200).end();
  });
  await new Promise<void>((r) => s3Server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(s3Server.address() as AddressInfo).port}`;
});
after(() => s3Server.close());

const KEY = randomBytes(32);
let dir: string;
let clock: number;

beforeEach(() => {
  objects.clear();
  requests = [];
  dir = mkdtempSync(join(tmpdir(), 'envolvr-backup-'));
  clock = Date.parse('2026-09-25T12:00:00.000Z');
});

const s3 = () => new S3Client({ endpoint, bucket: 'ledger', region: 'auto', ...CREDS });
const backups = (key = KEY) => new LedgerBackups(s3(), key, { prefix: 'control-db/', now: () => new Date(clock) });

function ledger(name: string) {
  const path = join(dir, name);
  const store = new Store(path);
  return { path, store };
}

test('S3Client: put, get, list across pages, delete; keys with spaces and unicode', async () => {
  const c = s3();
  const keys = ['a/1', 'a/2 b', 'a/ü&3', 'b/4'];
  for (const k of keys) await c.put(k, Buffer.from(k));
  assert.deepEqual((await c.list('a/')).map((o) => o.key), ['a/1', 'a/2 b', 'a/ü&3']);
  assert.equal((await c.get('a/ü&3')).toString(), 'a/ü&3');
  await c.delete('a/1');
  assert.deepEqual((await c.list('')).map((o) => o.key), ['a/2 b', 'a/ü&3', 'b/4']);
  await assert.rejects(c.get('missing'), /404 NoSuchKey/);
  await assert.rejects(new S3Client({ endpoint, bucket: 'ledger', region: 'auto', accessKeyId: 'x', secretAccessKey: 'y' })
    .list(''), /403 SignatureDoesNotMatch/);
});

test('seal and open: round trip; wrong key, altered bytes and a different name all fail', () => {
  const name = objectName(new Date(clock));
  assert.equal(name, '20260925T120000000Z.db.gz.enc');
  const sealed = seal(KEY, name, Buffer.from('ledger'));
  assert.equal(open(KEY, name, sealed).toString(), 'ledger');
  assert.throws(() => open(randomBytes(32), name, sealed), /authentication failed/);
  const flipped = Buffer.from(sealed);
  flipped[20] ^= 1;
  assert.throws(() => open(KEY, name, flipped), /authentication failed/);
  assert.throws(() => open(KEY, objectName(new Date(clock + 1)), sealed), /authentication failed/);
  assert.throws(() => open(KEY, name, Buffer.from('nope')), /not a ledger backup/);
});

test('backs up changes only, restores the newest into a fresh file', async () => {
  const { path, store } = ledger('control.db');
  const b = backups();
  const acct = store.ensureAccount('0x' + '1'.repeat(40), 1);
  store.credit(acct.id, 5_000_000n);
  const first = await b.backupOnce(store.db, path);
  assert.equal(first, 'control-db/20260925T120000000Z.db.gz.enc');
  clock += 60_000;
  assert.equal(await b.backupOnce(store.db, path), null, 'unchanged ledger is not uploaded again');
  store.credit(acct.id, 2_000_000n);
  const second = await b.backupOnce(store.db, path);
  assert.equal(second, 'control-db/20260925T120100000Z.db.gz.enc');
  assert.ok(!existsSync(`${path}.snapshot`));
  store.close();

  const target = join(dir, 'restored.db');
  assert.equal(await backups().restore(target), second);
  const restored = new Store(target);
  assert.equal(restored.accountByWallet('0x' + '1'.repeat(40))?.balanceMicros, 7_000_000n);
  restored.close();

  const pinned = join(dir, 'pinned.db');
  assert.equal(await backups().restore(pinned, '20260925T120000000Z.db.gz.enc'), first);
  const older = new Store(pinned);
  assert.equal(older.accountByWallet('0x' + '1'.repeat(40))?.balanceMicros, 5_000_000n);
  older.close();
  await assert.rejects(backups().restore(join(dir, 'x.db'), 'control-db/20270101T000000000Z.db.gz.enc'), /not found/);
});

test('restore: empty bucket gives null; a wrong key or a swapped object fails and leaves no file', async () => {
  assert.equal(await backups().restore(join(dir, 'none.db')), null);
  const { path, store } = ledger('control.db');
  const b = backups();
  store.ensureAccount('0x' + '2'.repeat(40), 1);
  const older = (await b.backupOnce(store.db, path))!;
  clock += 60_000;
  store.ensureAccount('0x' + '3'.repeat(40), 1);
  const newer = (await b.backupOnce(store.db, path))!;
  store.close();

  const target = join(dir, 'restored.db');
  await assert.rejects(backups(randomBytes(32)).restore(target), /authentication failed/);
  assert.ok(!existsSync(target) && !existsSync(`${target}.restore`));

  objects.set(newer, objects.get(older)!); // replay an older backup under the newest name
  await assert.rejects(backups().restore(target), /authentication failed/);
  assert.ok(!existsSync(target));
});

test('restore removes a stale WAL left beside the missing ledger', async () => {
  const { path, store } = ledger('control.db');
  const b = backups();
  store.ensureAccount('0x' + '4'.repeat(40), 1);
  await b.backupOnce(store.db, path);
  store.close();
  rmSync(path);
  writeFileSync(`${path}-wal`, 'stale');
  await backups().restore(path);
  assert.ok(!existsSync(`${path}-wal`));
  const s = new Store(path);
  assert.ok(s.accountByWallet('0x' + '4'.repeat(40)));
  s.close();
});

test('prune: drops backups past retention, keeps the newest and foreign objects', async () => {
  const c = s3();
  const day = 86_400_000;
  const names = [40, 35, 31, 29, 1].map((d) => `control-db/${objectName(new Date(clock - d * day))}`);
  for (const n of names) await c.put(n, Buffer.from('x'));
  await c.put('control-db/notes.txt', Buffer.from('x'));
  await c.put('other/20200101T000000000Z.db.gz.enc', Buffer.from('x'));
  const b = new LedgerBackups(c, KEY, { prefix: 'control-db/', retainDays: 30, keepLatest: 2, now: () => new Date(clock) });
  assert.deepEqual(await b.prune(), names.slice(0, 3));
  assert.deepEqual([...objects.keys()].sort(), [...names.slice(3), 'control-db/notes.txt', 'other/20200101T000000000Z.db.gz.enc'].sort());

  // Never below keepLatest, however old.
  const keep = new LedgerBackups(c, KEY, { prefix: 'control-db/', retainDays: 30, keepLatest: 2, now: () => new Date(clock + 400 * day) });
  assert.deepEqual(await keep.prune(), []);
});

test('start: backs up at once, and the stop function takes a final backup', async () => {
  const { path, store } = ledger('control.db');
  const b = backups();
  store.ensureAccount('0x' + '5'.repeat(40), 1);
  const stop = b.start(store.db, path, 3_600_000);
  await b.backupOnce(store.db, path); // waits for the first run
  assert.equal([...objects.keys()].length, 1);
  clock += 1_000;
  store.ensureAccount('0x' + '6'.repeat(40), 1);
  await stop();
  assert.equal([...objects.keys()].length, 2);
  store.close();
  assert.ok(requests.some((r) => r.startsWith('PUT /ledger/control-db/')));
});

test('dstackKey: GetKey over a unix socket; rejects a key that is not 32 bytes', async () => {
  const sock = join(dir, 'dstack.sock');
  let reply = 'ab'.repeat(32);
  let seen: unknown;
  const agent = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen = { url: req.url, method: req.method, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ key: reply, signature_chain: [] }));
  });
  await new Promise<void>((r) => agent.listen(sock, r));
  try {
    const key = await dstackKey(`unix:${sock}`, 'envolvr/control/ledger-backup', 'encryption');
    assert.equal(key.toString('hex'), 'ab'.repeat(32));
    assert.deepEqual(seen, { url: '/GetKey', method: 'POST', body: { path: 'envolvr/control/ledger-backup', purpose: 'encryption' } });
    assert.equal((await ledgerBackupKey(sock)).length, 32);
    reply = 'ab'.repeat(31);
    await assert.rejects(dstackKey(sock, 'p'), /31 bytes, want 32/);
  } finally {
    agent.close();
  }
});

test('loadConfig: backup credentials come from the environment and are required', () => {
  const path = join(dir, 'config.json');
  const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const env = { CONTROL_TOKEN: 'c'.repeat(32), ADMIN_TOKEN: 'a'.repeat(32) };
  const backup = { endpoint: 'https://s3.us-east-005.backblazeb2.com', bucket: 'b', region: 'us-east-005', prefix: 'control-db/' };
  writeFileSync(path, JSON.stringify(base));
  assert.equal(loadConfig(path, env).backup, undefined);
  writeFileSync(path, JSON.stringify({ ...base, backup: { ...backup, accessKeyId: 'from-file' } }));
  assert.throws(() => loadConfig(path, env), /BACKUP_ACCESS_KEY_ID and BACKUP_SECRET_ACCESS_KEY must be set/);
  const withCreds = { ...env, BACKUP_ACCESS_KEY_ID: 'id', BACKUP_SECRET_ACCESS_KEY: 'secret' };
  assert.deepEqual(loadConfig(path, withCreds).backup, { ...backup, accessKeyId: 'id', secretAccessKey: 'secret' });
  writeFileSync(path, JSON.stringify({ ...base, backup: { ...backup, prefix: 'control-db' } }));
  assert.throws(() => loadConfig(path, withCreds), /must end with/);
});

test('verifyLatest: checks the newest copy without touching the ledger; fails on a wrong key', async () => {
  const { path, store } = ledger('control.db');
  assert.equal(await backups().verifyLatest(path), null);
  store.ensureAccount('0x' + '7'.repeat(40), 1);
  const b = backups();
  const key = await b.backupOnce(store.db, path);
  const restarted = backups();
  assert.equal(await restarted.verifyLatest(path), key);
  assert.equal(await restarted.backupOnce(store.db, path), null, 'the verified copy is current: nothing to upload');
  await assert.rejects(backups(randomBytes(32)).verifyLatest(path), /verify .*authentication failed/);
  assert.ok(!existsSync(`${path}.verify`));
  assert.ok(store.accountByWallet('0x' + '7'.repeat(40)));
  store.close();
});

test('S3Client: a request that hangs times out', async () => {
  const hang = createServer(() => {});
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
  try {
    const c = new S3Client({
      endpoint: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`, bucket: 'ledger', region: 'auto', ...CREDS,
      timeoutMs: 100,
    });
    await assert.rejects(c.list(''), /timeout|aborted/i);
  } finally {
    hang.closeAllConnections();
    hang.close();
  }
});

test('LedgerBackups: unset options fall back to the defaults', async () => {
  const c = s3();
  const day = 86_400_000;
  for (let d = 60; d > 0; d--) await c.put(`control-db/${objectName(new Date(clock - d * day))}`, Buffer.from('x'));
  const b = new LedgerBackups(c, KEY, { prefix: 'control-db/', retainDays: undefined, now: () => new Date(clock) });
  assert.equal((await b.prune()).length, 30, 'daily copies for 60 days, 30-day window');
});
