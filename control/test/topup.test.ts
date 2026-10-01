import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type TopUpRuleEvent } from '../src/db.ts';
import { type OnChainRule, type TopUpChain, TopUpKeeper } from '../src/topup.ts';

const NOW = 1_790_000_000;
const DAY = 86_400;
const PAYER = '0x' + 'aa'.repeat(20);
const AGENT = '0x' + 'bb'.repeat(20);

/** A chain with one vault: rules, the payer's USDG and approval, and the top-ups sent. */
function stubChain(over: Partial<{ rule: OnChainRule; balance: bigint; approved: bigint; logs: TopUpRuleEvent[] }> = {}) {
  const sent: { payer: string; account: string }[] = [];
  const chain: TopUpChain & { sent: typeof sent; state: typeof s } = {
    address: '0x' + 'cc'.repeat(20),
    sent,
    state: undefined as never,
    latestBlock: async () => 100,
    ruleLogs: async (from, to) => s.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to),
    rule: async () => s.rule,
    usdgBalance: async () => s.balance,
    usdgAllowance: async () => s.approved,
    sendTopUp: async (payer, account) => {
      await new Promise((r) => setTimeout(r, 5));
      sent.push({ payer, account });
      return '0x' + 'dd'.repeat(32);
    },
  };
  const s = {
    rule: { belowMicros: 5_000_000n, amountMicros: 20_000_000n, maxPerDayMicros: 100_000_000n, day: 0, spentTodayMicros: 0n },
    balance: 1_000_000_000n, approved: 10n ** 18n, logs: [] as TopUpRuleEvent[], ...over,
  };
  chain.state = s;
  return chain;
}

const ruleEvent = (block: number, amount: bigint, below = 5_000_000n, payer = PAYER): TopUpRuleEvent => ({
  payer, account: AGENT, belowMicros: below, amountMicros: amount, maxPerDayMicros: amount * 5n, blockNumber: block, logIndex: 0,
});

function setup(balanceMicros: bigint, opts: { allowance?: bigint; blocked?: boolean; chain?: ReturnType<typeof stubChain> } = {}) {
  const store = new Store(':memory:');
  const a = store.ensureAccount(AGENT, NOW);
  store.credit(a.id, balanceMicros);
  const chain = opts.chain ?? stubChain();
  store.applyTopUpRules('topup-rules', [ruleEvent(1, 20_000_000n)], 1);
  const logs: string[] = [];
  const keeper = new TopUpKeeper(store, chain, { allowanceMicros: async () => opts.allowance ?? 0n }, {
    startBlock: 0, now: () => NOW, log: (m) => logs.push(m), screen: async () => opts.blocked ?? false,
  });
  return { store, chain, keeper, logs };
}

test('rules follow the chain in order: set, change, clear; the cursor advances', async () => {
  const store = new Store(':memory:');
  const chain = stubChain({
    logs: [ruleEvent(10, 20_000_000n), ruleEvent(12, 30_000_000n, 8_000_000n), ruleEvent(11, 1n, 1n, '0x' + 'ee'.repeat(20)),
      { ...ruleEvent(20, 0n), payer: '0x' + 'ee'.repeat(20) }],
  });
  const keeper = new TopUpKeeper(store, chain, { allowanceMicros: async () => 0n }, { startBlock: 5 });
  assert.equal(await keeper.syncRules(), 99); // one confirmation behind the head
  assert.deepEqual(store.topUpRules(AGENT), [{
    payer: PAYER, account: AGENT, belowMicros: 8_000_000n, amountMicros: 30_000_000n, maxPerDayMicros: 150_000_000n,
  }]);
  assert.equal(store.cursor('topup-rules'), 99);
});

test('credit at or above the threshold: nothing is sent', async () => {
  const { keeper, chain } = setup(5_000_000n);
  assert.deepEqual(await keeper.check(AGENT), ['ok']);
  assert.equal(chain.sent.length, 0);
});

test('the staking allowance left counts as credit', async () => {
  const { keeper, chain } = setup(1_000_000n, { allowance: 4_000_000n });
  assert.deepEqual(await keeper.check(AGENT), ['ok']);
  assert.equal(chain.sent.length, 0);
});

test('credit below the threshold: one top-up is sent, and not repeated while it is being credited', async () => {
  const { keeper, chain, logs } = setup(1_000_000n);
  assert.deepEqual(await keeper.check(AGENT), ['sent']);
  assert.deepEqual(chain.sent, [{ payer: PAYER, account: AGENT }]);
  assert.deepEqual(await keeper.check(AGENT), ['pending']);
  assert.equal(chain.sent.length, 1);
  assert.ok(logs.includes('top-up sent'));
});

test('concurrent checks of one account share one top-up', async () => {
  const { keeper, chain } = setup(0n);
  await Promise.all([keeper.check(AGENT), keeper.check(AGENT), keeper.check(AGENT)]);
  assert.equal(chain.sent.length, 1);
});

test('no transaction bound to fail: a spent cap, missing USDG or approval, a blocked payer, a cleared rule', async () => {
  const today = Math.floor(NOW / DAY);
  const capped = stubChain({ rule: { belowMicros: 5n, amountMicros: 20_000_000n, maxPerDayMicros: 40_000_000n, day: today, spentTodayMicros: 40_000_000n } });
  assert.deepEqual(await setup(0n, { chain: capped }).keeper.check(AGENT), ['capped']);
  // yesterday's spending does not count today
  const yesterday = stubChain({ rule: { belowMicros: 5n, amountMicros: 20_000_000n, maxPerDayMicros: 40_000_000n, day: today - 1, spentTodayMicros: 40_000_000n } });
  assert.deepEqual(await setup(0n, { chain: yesterday }).keeper.check(AGENT), ['sent']);
  assert.deepEqual(await setup(0n, { chain: stubChain({ balance: 1n }) }).keeper.check(AGENT), ['no-funds']);
  assert.deepEqual(await setup(0n, { chain: stubChain({ approved: 0n }) }).keeper.check(AGENT), ['no-funds']);
  assert.deepEqual(await setup(0n, { blocked: true }).keeper.check(AGENT), ['blocked']);
  const cleared = stubChain({ rule: { belowMicros: 0n, amountMicros: 0n, maxPerDayMicros: 0n, day: 0, spentTodayMicros: 0n } });
  assert.deepEqual(await setup(0n, { chain: cleared }).keeper.check(AGENT), ['no-rule']);
  for (const c of [capped, cleared]) assert.equal(c.sent.length, 0);
});

test('a failed send is logged and reported, not thrown', async () => {
  const chain = stubChain();
  chain.sendTopUp = async () => { throw new Error('nonce too low'); };
  const { keeper, logs } = setup(0n, { chain });
  assert.deepEqual(await keeper.check(AGENT), ['failed']);
  assert.ok(logs.includes('top-up failed'));
});

test('an account without a rule is not checked', async () => {
  const { keeper } = setup(0n);
  assert.deepEqual(await keeper.check('0x' + '12'.repeat(20)), []);
});

test('the server asks the keeper to check an account after a request billed to its balance', async () => {
  const { createControlServer } = await import('../src/server.ts');
  const store = new Store(':memory:');
  const account = store.ensureAccount(AGENT, NOW);
  store.credit(account.id, 1_000_000n);
  const checked: string[] = [];
  const server = createControlServer({
    config: {
      port: 0, dbPath: ':memory:', marginBps: 0, minAvailableMicros: 1000, blockedWallets: [], controlToken: 'c'.repeat(40),
      adminToken: 'a'.repeat(40),
      models: { m: { routes: [{ upstream: 'redpill', inputCostPerToken: '0.0000014', outputCostPerToken: '0.0000044' }] } },
    },
    store, allowance: { allowanceMicros: async () => 0n }, topUp: { check: async (w: string) => { checked.push(w); } },
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const report = (requestId: string, userId: number | null) => fetch(`${base}/consult/post`, {
    method: 'POST', headers: { authorization: `Bearer ${'c'.repeat(40)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, attemptIndex: 0, requestModel: 'm', selectedRouteId: 'redpill:m', status: 200,
      usage: { prompt_tokens: 100, completion_tokens: 10 }, userId }),
  });
  try {
    await report('r1', account.id);
    await report('r2', null); // no account: nothing to check
    assert.deepEqual(checked, [AGENT]);
  } finally {
    server.close();
  }
});
