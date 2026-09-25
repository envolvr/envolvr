// Control-plane state in SQLite (node:sqlite). Money columns are micro-USD
// integers. Usage reports are keyed by (request_id, attempt_index), so a replayed
// report is ignored instead of billed twice. Receipt digests are keyed by digest,
// so a digest the gateway sends twice is kept once.

import { DatabaseSync } from 'node:sqlite';

export interface Account {
  id: number;
  wallet: string;
  balanceMicros: bigint;
}

export interface DepositEvent {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  account: string;
  payer: string;
  amountMicros: bigint;
  depositId: number;
}

export interface AnchorBatch {
  batchIndex: number;
  root: string;
  count: number;
  createdAt: number;
  txHash: string | null;
  sentAt: number | null;
  /** Block time the contract recorded; null until confirmed on chain. */
  anchoredAt: number | null;
  blockNumber: number | null;
}

interface BatchRow {
  batch_index: number; root: string; count: number; created_at: number; tx_hash: string | null;
  sent_at: number | null; anchored_at: number | null; block_number: number | null;
}

const batchOf = (r: BatchRow): AnchorBatch => ({
  batchIndex: r.batch_index, root: r.root, count: r.count, createdAt: r.created_at, txHash: r.tx_hash,
  sentAt: r.sent_at, anchoredAt: r.anchored_at, blockNumber: r.block_number,
});

/** The fee kept from a deposit: `bps` of it, rounded down (in the depositor's favor). */
export function depositFee(amountMicros: bigint, bps: number): bigint {
  return (amountMicros * BigInt(bps)) / 10_000n;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY,
        wallet TEXT NOT NULL UNIQUE,
        balance_micros INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        key_hash TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS allowance_usage (
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        day_start INTEGER NOT NULL,
        used_micros INTEGER NOT NULL,
        PRIMARY KEY (account_id, day_start)
      );
      CREATE TABLE IF NOT EXISTS usage_reports (
        request_id TEXT NOT NULL,
        attempt_index INTEGER NOT NULL,
        account_id INTEGER,
        model TEXT NOT NULL,
        route TEXT,
        status INTEGER NOT NULL,
        cost_micros INTEGER NOT NULL,
        from_allowance_micros INTEGER NOT NULL,
        from_balance_micros INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (request_id, attempt_index)
      );
      CREATE TABLE IF NOT EXISTS auth_nonces (
        nonce TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deposits (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        payer TEXT NOT NULL,
        amount_micros INTEGER NOT NULL,
        deposit_id INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE TABLE IF NOT EXISTS chain_cursor (
        name TEXT PRIMARY KEY,
        block_number INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipt_digests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        digest TEXT NOT NULL UNIQUE,
        received_at INTEGER NOT NULL,
        batch_index INTEGER,
        leaf_index INTEGER
      );
      CREATE INDEX IF NOT EXISTS receipt_digests_unbatched ON receipt_digests (seq) WHERE batch_index IS NULL;
      CREATE INDEX IF NOT EXISTS receipt_digests_batch ON receipt_digests (batch_index, leaf_index);
      CREATE TABLE IF NOT EXISTS settings (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallet_screening (
        wallet TEXT PRIMARY KEY,
        sanctioned INTEGER NOT NULL,
        checked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS anchor_batches (
        batch_index INTEGER PRIMARY KEY,
        root TEXT NOT NULL,
        count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        tx_hash TEXT,
        sent_at INTEGER,
        anchored_at INTEGER,
        block_number INTEGER
      );
    `);
    // Added after the first deployments: a deposit held by sanctions screening.
    const depositColumns = this.db.prepare('PRAGMA table_info(deposits)').all() as { name: string }[];
    if (!depositColumns.some((c) => c.name === 'held')) {
      this.db.exec('ALTER TABLE deposits ADD COLUMN held INTEGER NOT NULL DEFAULT 0');
    }
    // Added with the deposit fee: what was kept from each deposit (0 before it).
    if (!depositColumns.some((c) => c.name === 'fee_micros')) {
      this.db.exec('ALTER TABLE deposits ADD COLUMN fee_micros INTEGER NOT NULL DEFAULT 0');
    }
  }

  cursor(name: string): number | undefined {
    const row = this.db.prepare('SELECT block_number FROM chain_cursor WHERE name = ?').get(name) as
      { block_number: number } | undefined;
    return row?.block_number;
  }

  /**
   * Credit a batch of vault deposits and advance the cursor to `throughBlock`, in
   * one transaction. A deposit already recorded (same tx hash and log index) is
   * skipped, so replaying a block range never credits twice. The deposit fee
   * (`feeBps`, rounded down) is kept and recorded; the rest is credited. A
   * deposit `hold` selects is recorded as held and not credited.
   */
  applyDeposits(cursorName: string, deposits: DepositEvent[], throughBlock: number, now: number,
    hold: (d: DepositEvent) => boolean = () => false, feeBps = 0): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let credited = 0;
      for (const d of deposits) {
        const account = this.ensureAccount(d.account, now);
        const held = hold(d);
        const fee = depositFee(d.amountMicros, feeBps);
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO deposits
          (tx_hash, log_index, account_id, payer, amount_micros, deposit_id, block_number, held, fee_micros)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(d.txHash.toLowerCase(), d.logIndex, account.id, d.payer.toLowerCase(), d.amountMicros, d.depositId, d.blockNumber,
            held ? 1 : 0, fee);
        if (inserted.changes === 1 && !held) {
          this.credit(account.id, d.amountMicros - fee);
          credited++;
        }
      }
      this.db.prepare(`INSERT INTO chain_cursor (name, block_number) VALUES (?, ?)
        ON CONFLICT (name) DO UPDATE SET block_number = excluded.block_number`).run(cursorName, throughBlock);
      this.db.exec('COMMIT');
      return credited;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** The deposit fee in basis points: the ledger's setting, or `fallback` until one is set. */
  depositFeeBps(fallback: number): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE name = 'deposit_fee_bps'").get() as { value: string } | undefined;
    return row ? Number(row.value) : fallback;
  }

  setDepositFeeBps(bps: number, now: number): void {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('deposit fee must be 0 to 10000 basis points');
    this.db.prepare(`INSERT INTO settings (name, value, updated_at) VALUES ('deposit_fee_bps', ?, ?)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(String(bps), now);
  }

  screeningResult(wallet: string): { sanctioned: boolean; checkedAt: number } | undefined {
    const row = this.db.prepare('SELECT sanctioned, checked_at FROM wallet_screening WHERE wallet = ?')
      .get(wallet.toLowerCase()) as { sanctioned: number; checked_at: number } | undefined;
    return row && { sanctioned: row.sanctioned === 1, checkedAt: row.checked_at };
  }

  recordScreening(wallet: string, sanctioned: boolean, now: number): void {
    this.db.prepare(`INSERT INTO wallet_screening (wallet, sanctioned, checked_at) VALUES (?, ?, ?)
      ON CONFLICT (wallet) DO UPDATE SET sanctioned = excluded.sanctioned, checked_at = excluded.checked_at`)
      .run(wallet.toLowerCase(), sanctioned ? 1 : 0, now);
  }

  heldDeposits(): {
    txHash: string; logIndex: number; wallet: string; payer: string; amountMicros: bigint; feeMicros: bigint; depositId: number;
    blockNumber: number;
  }[] {
    const rows = this.db.prepare(`SELECT d.tx_hash, d.log_index, a.wallet, d.payer, d.amount_micros, d.fee_micros, d.deposit_id,
      d.block_number FROM deposits d JOIN accounts a ON a.id = d.account_id WHERE d.held = 1 ORDER BY d.block_number, d.log_index`)
      .all() as {
        tx_hash: string; log_index: number; wallet: string; payer: string; amount_micros: number; fee_micros: number;
        deposit_id: number; block_number: number;
      }[];
    return rows.map((r) => ({
      txHash: r.tx_hash, logIndex: r.log_index, wallet: r.wallet, payer: r.payer, amountMicros: BigInt(r.amount_micros),
      feeMicros: BigInt(r.fee_micros), depositId: r.deposit_id, blockNumber: r.block_number,
    }));
  }

  /** Credit a held deposit (after review), net of its fee. Returns the amount credited, or undefined if it is not held. */
  releaseDeposit(txHash: string, logIndex: number): bigint | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`UPDATE deposits SET held = 0 WHERE tx_hash = ? AND log_index = ? AND held = 1
        RETURNING account_id, amount_micros, fee_micros`).get(txHash.toLowerCase(), logIndex) as
        { account_id: number; amount_micros: number; fee_micros: number } | undefined;
      const net = row && BigInt(row.amount_micros) - BigInt(row.fee_micros);
      if (row) this.credit(row.account_id, net!);
      this.db.exec('COMMIT');
      return net;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Record receipt digests (0x + 64 lowercase hex). Returns how many were new. */
  addReceiptDigests(digests: string[], now: number): number {
    const insert = this.db.prepare('INSERT OR IGNORE INTO receipt_digests (digest, received_at) VALUES (?, ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let added = 0;
      for (const d of digests) added += Number(insert.run(d, now).changes);
      this.db.exec('COMMIT');
      return added;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Digests received before `receivedBefore` (unix s) and not yet in a batch, oldest first. */
  unbatchedDigests(limit: number, receivedBefore: number): string[] {
    return (this.db.prepare(`SELECT digest FROM receipt_digests WHERE batch_index IS NULL AND received_at < ?
      ORDER BY seq LIMIT ?`).all(receivedBefore, limit) as { digest: string }[]).map((r) => r.digest);
  }

  /** Create batch `batchIndex` over `digests` (in leaf order), in one transaction. */
  createBatch(batchIndex: number, root: string, digests: string[], now: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO anchor_batches (batch_index, root, count, created_at) VALUES (?, ?, ?, ?)')
        .run(batchIndex, root, digests.length, now);
      const assign = this.db.prepare(
        'UPDATE receipt_digests SET batch_index = ?, leaf_index = ? WHERE digest = ? AND batch_index IS NULL');
      digests.forEach((d, i) => {
        if (assign.run(batchIndex, i, d).changes !== 1) throw new Error(`digest ${d} is missing or already batched`);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Drop a batch that never landed; its digests go back to the queue. */
  dissolveBatch(batchIndex: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE receipt_digests SET batch_index = NULL, leaf_index = NULL WHERE batch_index = ?').run(batchIndex);
      this.db.prepare('DELETE FROM anchor_batches WHERE batch_index = ?').run(batchIndex);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  batchSent(batchIndex: number, txHash: string, now: number): void {
    this.db.prepare('UPDATE anchor_batches SET tx_hash = ?, sent_at = ? WHERE batch_index = ?').run(txHash, now, batchIndex);
  }

  batchAnchored(batchIndex: number, anchoredAt: number, blockNumber: number | null): void {
    this.db.prepare('UPDATE anchor_batches SET anchored_at = ?, block_number = ? WHERE batch_index = ?')
      .run(anchoredAt, blockNumber, batchIndex);
  }

  /** The oldest batch not yet confirmed on chain. */
  openBatch(): AnchorBatch | undefined {
    const row = this.db.prepare('SELECT * FROM anchor_batches WHERE anchored_at IS NULL ORDER BY batch_index LIMIT 1')
      .get() as BatchRow | undefined;
    return row && batchOf(row);
  }

  lastBatch(): AnchorBatch | undefined {
    const row = this.db.prepare('SELECT * FROM anchor_batches ORDER BY batch_index DESC LIMIT 1').get() as BatchRow | undefined;
    return row && batchOf(row);
  }

  batch(batchIndex: number): AnchorBatch | undefined {
    const row = this.db.prepare('SELECT * FROM anchor_batches WHERE batch_index = ?').get(batchIndex) as BatchRow | undefined;
    return row && batchOf(row);
  }

  /** Where a digest sits: its batch and leaf, or null batch while queued. */
  receiptDigest(digest: string): { batchIndex: number | null; leafIndex: number | null } | undefined {
    const row = this.db.prepare('SELECT batch_index, leaf_index FROM receipt_digests WHERE digest = ?').get(digest) as
      { batch_index: number | null; leaf_index: number | null } | undefined;
    return row && { batchIndex: row.batch_index, leafIndex: row.leaf_index };
  }

  /** A batch's digests in leaf order. */
  batchDigests(batchIndex: number): string[] {
    return (this.db.prepare('SELECT digest FROM receipt_digests WHERE batch_index = ? ORDER BY leaf_index')
      .all(batchIndex) as { digest: string }[]).map((r) => r.digest);
  }

  accountByWallet(wallet: string): Account | undefined {
    const row = this.db.prepare('SELECT id, wallet, balance_micros FROM accounts WHERE wallet = ?')
      .get(wallet.toLowerCase()) as { id: number; wallet: string; balance_micros: number } | undefined;
    return row && { id: row.id, wallet: row.wallet, balanceMicros: BigInt(row.balance_micros) };
  }

  accountByKeyHash(keyHash: string): Account | undefined {
    const row = this.db.prepare(`
      SELECT a.id, a.wallet, a.balance_micros FROM api_keys k JOIN accounts a ON a.id = k.account_id
      WHERE k.key_hash = ? AND k.revoked_at IS NULL`).get(keyHash) as
      { id: number; wallet: string; balance_micros: number } | undefined;
    return row && { id: row.id, wallet: row.wallet, balanceMicros: BigInt(row.balance_micros) };
  }

  ensureAccount(wallet: string, now: number): Account {
    this.db.prepare('INSERT OR IGNORE INTO accounts (wallet, created_at) VALUES (?, ?)').run(wallet.toLowerCase(), now);
    return this.accountByWallet(wallet)!;
  }

  addApiKey(accountId: number, keyHash: string, now: number): void {
    this.db.prepare('INSERT INTO api_keys (key_hash, account_id, created_at) VALUES (?, ?, ?)').run(keyHash, accountId, now);
  }

  credit(accountId: number, micros: bigint): void {
    this.db.prepare('UPDATE accounts SET balance_micros = balance_micros + ? WHERE id = ?').run(micros, accountId);
  }

  allowanceUsed(accountId: number, dayStart: number): bigint {
    const row = this.db.prepare('SELECT used_micros FROM allowance_usage WHERE account_id = ? AND day_start = ?')
      .get(accountId, dayStart) as { used_micros: number } | undefined;
    return BigInt(row?.used_micros ?? 0);
  }

  putNonce(nonce: string, wallet: string, expiresAt: number): void {
    this.db.prepare('INSERT INTO auth_nonces (nonce, wallet, expires_at) VALUES (?, ?, ?)').run(nonce, wallet.toLowerCase(), expiresAt);
  }

  /** Single use: the nonce is deleted whether or not it is still valid. */
  takeNonce(nonce: string, wallet: string, now: number): boolean {
    const row = this.db.prepare('DELETE FROM auth_nonces WHERE nonce = ? RETURNING wallet, expires_at')
      .get(nonce) as { wallet: string; expires_at: number } | undefined;
    return !!row && row.wallet === wallet.toLowerCase() && row.expires_at > now;
  }

  /**
   * Record one usage report and debit it: the day's allowance first, then the
   * USDG balance. Returns false when this (request, attempt) was already recorded.
   */
  recordUsage(r: {
    requestId: string; attemptIndex: number; accountId: number | null; model: string; route: string | null;
    status: number; costMicros: bigint; allowanceMicros: bigint; dayStart: number; now: number;
  }): { recorded: boolean; fromAllowance: bigint; fromBalance: bigint } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists = this.db.prepare('SELECT 1 FROM usage_reports WHERE request_id = ? AND attempt_index = ?')
        .get(r.requestId, r.attemptIndex);
      if (exists) {
        this.db.exec('ROLLBACK');
        return { recorded: false, fromAllowance: 0n, fromBalance: 0n };
      }
      let fromAllowance = 0n;
      let fromBalance = 0n;
      if (r.accountId !== null && r.costMicros > 0n) {
        const remaining = r.allowanceMicros - this.allowanceUsed(r.accountId, r.dayStart);
        fromAllowance = remaining > 0n ? (remaining < r.costMicros ? remaining : r.costMicros) : 0n;
        fromBalance = r.costMicros - fromAllowance;
        if (fromAllowance > 0n) {
          this.db.prepare(`INSERT INTO allowance_usage (account_id, day_start, used_micros) VALUES (?, ?, ?)
            ON CONFLICT (account_id, day_start) DO UPDATE SET used_micros = used_micros + excluded.used_micros`)
            .run(r.accountId, r.dayStart, fromAllowance);
        }
        if (fromBalance > 0n) {
          this.db.prepare('UPDATE accounts SET balance_micros = balance_micros - ? WHERE id = ?').run(fromBalance, r.accountId);
        }
      }
      this.db.prepare(`INSERT INTO usage_reports (request_id, attempt_index, account_id, model, route, status,
        cost_micros, from_allowance_micros, from_balance_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.requestId, r.attemptIndex, r.accountId, r.model, r.route, r.status, r.costMicros, fromAllowance,
          fromBalance, r.now);
      this.db.exec('COMMIT');
      return { recorded: true, fromAllowance, fromBalance };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
