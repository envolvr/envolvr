// Control-plane state in SQLite (node:sqlite). Money columns are micro-USD
// integers. Usage reports are keyed by (request_id, attempt_index), so a replayed
// report is ignored instead of billed twice.

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
    `);
  }

  cursor(name: string): number | undefined {
    const row = this.db.prepare('SELECT block_number FROM chain_cursor WHERE name = ?').get(name) as
      { block_number: number } | undefined;
    return row?.block_number;
  }

  /**
   * Credit a batch of vault deposits and advance the cursor to `throughBlock`, in
   * one transaction. A deposit already recorded (same tx hash and log index) is
   * skipped, so replaying a block range never credits twice.
   */
  applyDeposits(cursorName: string, deposits: DepositEvent[], throughBlock: number, now: number): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let credited = 0;
      for (const d of deposits) {
        const account = this.ensureAccount(d.account, now);
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO deposits
          (tx_hash, log_index, account_id, payer, amount_micros, deposit_id, block_number) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(d.txHash.toLowerCase(), d.logIndex, account.id, d.payer.toLowerCase(), d.amountMicros, d.depositId, d.blockNumber);
        if (inserted.changes === 1) {
          this.credit(account.id, d.amountMicros);
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
