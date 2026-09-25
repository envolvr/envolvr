import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../src/config.ts';
import { depositFee, Store, type DepositEvent } from '../src/db.ts';
import { DepositWatcher } from '../src/deposits.ts';
import { createControlServer } from '../src/server.ts';

const agent = '0x' + 'ab'.repeat(20);
const ev = (block: number, amount: bigint, account = agent): DepositEvent => ({
  txHash: `0x${block.toString(16).padStart(64, '0')}`, logIndex: 0, blockNumber: block, account, payer: account,
  amountMicros: amount, depositId: block,
});

test('the fee is kept from each deposit, rounded down, and recorded', () => {
  assert.equal(depositFee(10_000_000n, 500), 500_000n);
  assert.equal(depositFee(19n, 500), 0n, 'rounds down, in the depositor\'s favor');
  const store = new Store(':memory:');
  store.applyDeposits('v', [ev(1, 10_000_000n)], 1, 0, () => false, 500);
  assert.equal(store.accountByWallet(agent)?.balanceMicros, 9_500_000n);
  const row = store.db.prepare('SELECT amount_micros, fee_micros FROM deposits').get() as { amount_micros: number; fee_micros: number };
  assert.deepEqual({ ...row }, { amount_micros: 10_000_000, fee_micros: 500_000 });
});

test('a held deposit keeps its fee and is released net', () => {
  const store = new Store(':memory:');
  store.applyDeposits('v', [ev(2, 4_000_000n)], 2, 0, () => true, 500);
  assert.equal(store.heldDeposits()[0].feeMicros, 200_000n);
  assert.equal(store.releaseDeposit(ev(2, 0n).txHash, 0), 3_800_000n);
  assert.equal(store.accountByWallet(agent)?.balanceMicros, 3_800_000n);
});

test('the rate comes from the ledger once set, applies to the next deposit, and survives a restart', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'envolvr-fee-')), 'control.db');
  let store = new Store(path);
  assert.equal(store.depositFeeBps(500), 500, 'config value until one is set');
  const events = [ev(10, 1_000_000n)];
  const watcher = (s: Store) => new DepositWatcher(s, {
    latestBlock: async () => 100, depositLogs: async (from, to) => events.filter((e) => e.blockNumber >= from && e.blockNumber <= to),
  }, { startBlock: 1, confirmations: 0, feeBps: () => s.depositFeeBps(500) });
  await watcher(store).pollOnce();
  assert.equal(store.accountByWallet(agent)?.balanceMicros, 950_000n);
  store.setDepositFeeBps(200, 1);
  events.push(ev(150, 1_000_000n));
  store.close();
  store = new Store(path);
  assert.equal(store.depositFeeBps(500), 200);
  // The head moves past block 150; its deposit is credited at the new rate.
  const w = new DepositWatcher(store, {
    latestBlock: async () => 200, depositLogs: async (from, to) => events.filter((e) => e.blockNumber >= from && e.blockNumber <= to),
  }, { startBlock: 1, confirmations: 0, feeBps: () => store.depositFeeBps(500) });
  await w.pollOnce();
  assert.equal(store.accountByWallet(agent)?.balanceMicros, 950_000n + 980_000n);
  assert.throws(() => store.setDepositFeeBps(10_001, 2), /0 to 10000/);
  store.close();
});

test('a ledger from before the fee gains the fee column, with 0 for old deposits', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'envolvr-fee-mig-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE deposits (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, account_id INTEGER NOT NULL,
    payer TEXT NOT NULL, amount_micros INTEGER NOT NULL, deposit_id INTEGER NOT NULL, block_number INTEGER NOT NULL,
    held INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tx_hash, log_index));
    INSERT INTO deposits VALUES ('0x01', 0, 1, '0x02', 5, 0, 1, 0);`);
  old.close();
  const store = new Store(path);
  assert.deepEqual({ ...(store.db.prepare('SELECT fee_micros FROM deposits').get() as object) }, { fee_micros: 0 });
  store.close();
});

test('admin sets the fee at once; /pricing shows it; nothing is logged', async () => {
  const lines: string[] = [];
  const config: Config = {
    port: 0, dbPath: ':memory:', marginBps: 0, depositFeeBps: 500, minAvailableMicros: 1000, models: {}, blockedWallets: [],
    controlToken: 'c'.repeat(40), adminToken: 'a'.repeat(40),
  };
  const server = createControlServer({ config, store: new Store(':memory:'), allowance: { allowanceMicros: async () => 0n }, log: (m) => lines.push(m) });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = { authorization: `Bearer ${'a'.repeat(40)}`, 'content-type': 'application/json' };
  try {
    assert.deepEqual(await (await fetch(`${base}/pricing`)).json(), {
      depositFeeBps: 500, tokenPricing: 'provider list price', models: '/v1/models on the gateway lists every model with its per-token prices',
    });
    assert.equal((await fetch(`${base}/admin/deposit-fee`, { method: 'POST', body: '{"bps":300}' })).status, 401);
    assert.equal((await fetch(`${base}/admin/deposit-fee`, { method: 'POST', headers: admin, body: '{"bps":-1}' })).status, 400);
    assert.deepEqual(await (await fetch(`${base}/admin/deposit-fee`, { method: 'POST', headers: admin, body: '{"bps":300}' })).json(), { bps: 300 });
    assert.deepEqual(await (await fetch(`${base}/admin/deposit-fee`, { headers: admin })).json(), { bps: 300 });
    assert.equal(((await (await fetch(`${base}/pricing`)).json()) as { depositFeeBps: number }).depositFeeBps, 300);
    assert.deepEqual(lines, []);
  } finally {
    server.close();
  }
});
