import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { createControlServer } from '../src/server.ts';

const ADMIN = 'a'.repeat(40);
const config: Config = {
  port: 0, dbPath: ':memory:', marginBps: 0, minAvailableMicros: 1000, blockedWallets: [], models: {},
  controlToken: 'c'.repeat(40), adminToken: ADMIN, monitorToken: 'm'.repeat(40),
};
const NOW = 1_790_000_000; // a fixed clock
const DAY = 86_400;
const wallet = (n: number) => '0x' + n.toString(16).padStart(40, '0');

async function withServer(store: Store, vault: bigint | undefined, fn: (base: string) => Promise<void>) {
  const server = createControlServer({
    config, store, allowance: { allowanceMicros: async () => 0n }, now: () => NOW,
    reserves: vault === undefined ? undefined : { vaultUsdgMicros: async () => vault },
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}
const get = (base: string, path: string, token = ADMIN) =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

/** Three accounts: one with $5, one overdrawn by $0.25, one closed into a $2 refund; plus a held $10 deposit. */
function ledger(): Store {
  const store = new Store(':memory:');
  const a = store.ensureAccount(wallet(1), NOW);
  store.credit(a.id, 5_000_000n);
  const b = store.ensureAccount(wallet(2), NOW);
  store.credit(b.id, 1_000_000n);
  store.recordUsage({
    requestId: 'r1', attemptIndex: 0, accountId: b.id, model: 'm', route: 'chutes:m', status: 200,
    costMicros: 1_250_000n, allowanceMicros: 0n, dayStart: Math.floor(NOW / DAY) * DAY, now: NOW,
  });
  const c = store.ensureAccount(wallet(3), NOW);
  store.credit(c.id, 2_000_000n);
  store.closeAccount(c.id, wallet(9), false, NOW);
  store.applyDeposits('vault', [{
    txHash: '0x' + '11'.repeat(32), logIndex: 0, account: wallet(4), payer: wallet(4), amountMicros: 10_000_000n,
    depositId: 1, blockNumber: 1,
  }], 1, NOW, () => true, 500);
  return store;
}

test('liabilities count positive balances, unpaid refunds and held deposits; overdrafts stand apart', () => {
  const l = ledger().liabilities();
  assert.equal(l.balancesMicros, 5_000_000n);
  assert.equal(l.overdrawnMicros, 250_000n);
  assert.equal(l.refundsPendingMicros, 2_000_000n);
  assert.equal(l.refundsHeldMicros, 0n);
  assert.equal(l.depositsHeldMicros, 10_000_000n);
  assert.equal(l.owedMicros, 17_000_000n);
});

test('/admin/reserves: only the surplus over what is owed is withdrawable', async () => {
  await withServer(ledger(), 20_000_000n, async (base) => {
    const r = await (await get(base, '/admin/reserves')).json() as Record<string, unknown>;
    assert.equal(r.vaultUsdgMicros, '20000000');
    assert.equal(r.owedMicros, '17000000');
    assert.equal(r.withdrawableMicros, '3000000');
    assert.equal(r.solvent, true);
    assert.equal(r.shortfallMicros, '0');
  });
});

test('/admin/reserves: a vault below what is owed reports the shortfall and nothing withdrawable', async () => {
  await withServer(ledger(), 16_000_000n, async (base) => {
    const r = await (await get(base, '/admin/reserves')).json() as Record<string, unknown>;
    assert.equal(r.withdrawableMicros, '0');
    assert.equal(r.solvent, false);
    assert.equal(r.shortfallMicros, '1000000');
  });
});

test('/admin/reserves without a vault reports the liabilities alone', async () => {
  await withServer(ledger(), undefined, async (base) => {
    const r = await (await get(base, '/admin/reserves')).json() as Record<string, unknown>;
    assert.equal(r.owedMicros, '17000000');
    assert.equal(r.vaultUsdgMicros, null);
    assert.equal(r.withdrawableMicros, null);
  });
});

test('/admin/reserves and /admin/spend need the admin token', async () => {
  await withServer(ledger(), 1n, async (base) => {
    assert.equal((await get(base, '/admin/reserves', 'x'.repeat(40))).status, 401);
    assert.equal((await get(base, '/admin/spend', 'x'.repeat(40))).status, 401);
  });
});

test('/admin/spend groups billed cost by upstream and UTC day, with a daily average', async () => {
  const store = new Store(':memory:');
  const a = store.ensureAccount(wallet(1), NOW);
  store.credit(a.id, 100_000_000n);
  const today = Math.floor(NOW / DAY) * DAY;
  const use = (id: string, route: string | null, cost: bigint, at: number) => store.recordUsage({
    requestId: id, attemptIndex: 0, accountId: a.id, model: 'm', route, status: 200, costMicros: cost,
    allowanceMicros: 0n, dayStart: Math.floor(at / DAY) * DAY, now: at,
  });
  use('1', 'chutes:deepseek/v4', 1_000_000n, today + 10);
  use('2', 'chutes:kimi', 500_000n, today + 20);
  use('3', 'redpill:z-ai/glm-5.3', 2_000_000n, today - DAY + 5);
  use('4', 'near-ai:glm', 700_000n, today - 30 * DAY); // outside the window
  use('5', null, 9_000_000n, today); // no route: not a supplier's spend
  use('6', 'chutes:kimi', 0n, today); // free attempt
  await withServer(store, undefined, async (base) => {
    const r = await (await get(base, '/admin/spend?days=2')).json() as {
      since: number; daily: { upstream: string; dayStart: number; billedMicros: string; requests: number }[];
      upstreams: { upstream: string; totalMicros: string; perDayMicros: string }[];
    };
    assert.equal(r.since, today - DAY);
    assert.deepEqual(r.daily, [
      { upstream: 'redpill', dayStart: today - DAY, billedMicros: '2000000', requests: 1 },
      { upstream: 'chutes', dayStart: today, billedMicros: '1500000', requests: 2 },
    ]);
    assert.deepEqual(r.upstreams, [
      { upstream: 'redpill', totalMicros: '2000000', perDayMicros: '1000000' },
      { upstream: 'chutes', totalMicros: '1500000', perDayMicros: '750000' },
    ]);
  });
});

test('the monitor token reads /admin/reserves and /admin/spend, and nothing else under /admin', async () => {
  await withServer(ledger(), 20_000_000n, async (base) => {
    const m = 'm'.repeat(40);
    assert.equal((await get(base, '/admin/reserves', m)).status, 200);
    assert.equal((await get(base, '/admin/spend', m)).status, 200);
    assert.equal((await get(base, '/admin/refunds', m)).status, 401);
    assert.equal((await get(base, '/admin/deposits/held', m)).status, 401);
    const credit = await fetch(`${base}/admin/credit`, {
      method: 'POST', headers: { authorization: `Bearer ${m}`, 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: wallet(1), amountMicros: '1' }),
    });
    assert.equal(credit.status, 401);
  });
});
