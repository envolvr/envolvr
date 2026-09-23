import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DepositEvent } from '../src/db.ts';
import { Store } from '../src/db.ts';
import { decodeDepositLog, DEPOSITED_TOPIC, DepositWatcher, type LogSource } from '../src/deposits.ts';

const agent = '0x' + 'ab'.repeat(20);
const human = '0x' + 'cd'.repeat(20);

function source(head: number, events: DepositEvent[]): LogSource & { calls: [number, number][]; head: number } {
  const s = {
    head,
    calls: [] as [number, number][],
    latestBlock: async () => s.head,
    depositLogs: async (from: number, to: number) => {
      s.calls.push([from, to]);
      return events.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
    },
  };
  return s;
}

const ev = (block: number, logIndex: number, amount: bigint, account = agent, payer = human): DepositEvent => ({
  txHash: `0x${block.toString(16).padStart(64, '0')}`, logIndex, blockNumber: block, account, payer, amountMicros: amount, depositId: block,
});

test('decodes a Deposited log', () => {
  const log = {
    topics: [DEPOSITED_TOPIC, `0x${'0'.repeat(24)}${agent.slice(2)}`, `0x${'0'.repeat(24)}${human.slice(2)}`, `0x${'0'.repeat(63)}7`],
    data: `0x${(5_000_000).toString(16).padStart(64, '0')}`,
    transactionHash: '0x' + '11'.repeat(32), logIndex: '0x2', blockNumber: '0x64',
  };
  assert.deepEqual(decodeDepositLog(log), {
    txHash: log.transactionHash, logIndex: 2, blockNumber: 100, account: agent, payer: human, depositId: 7, amountMicros: 5_000_000n,
  });
});

test('credits each deposit once, stays behind the head, and resumes from the cursor', async () => {
  const store = new Store(':memory:');
  const src = source(110, [ev(100, 0, 5_000_000n), ev(105, 1, 2_000_000n), ev(111, 0, 1_000_000n)]);
  const watcher = new DepositWatcher(store, src, { startBlock: 100, confirmations: 2, maxRange: 1_000 });

  assert.deepEqual(await watcher.pollOnce(), { credited: 2, throughBlock: 108 });
  assert.equal(store.accountByWallet(agent)!.balanceMicros, 7_000_000n);

  // Nothing new until the head moves past the confirmation depth.
  assert.deepEqual(await watcher.pollOnce(), { credited: 0, throughBlock: 108 });
  src.head = 113;
  assert.deepEqual(await watcher.pollOnce(), { credited: 1, throughBlock: 111 });
  assert.equal(store.accountByWallet(agent)!.balanceMicros, 8_000_000n);
  assert.deepEqual(src.calls, [[100, 108], [109, 111]]);
});

test('replaying a range never credits twice', async () => {
  const store = new Store(':memory:');
  const deposits = [ev(100, 0, 5_000_000n), ev(100, 1, 1_000_000n)];
  assert.equal(store.applyDeposits('v', deposits, 100, 0), 2);
  assert.equal(store.applyDeposits('v', deposits, 100, 0), 0);
  assert.equal(store.accountByWallet(agent)!.balanceMicros, 6_000_000n);
});

test('large gaps are processed in bounded ranges', async () => {
  const store = new Store(':memory:');
  const src = source(25_000, [ev(12_345, 0, 1n)]);
  const watcher = new DepositWatcher(store, src, { startBlock: 1, confirmations: 0, maxRange: 10_000 });
  while ((await watcher.pollOnce()).throughBlock! < 25_000) { /* catch up */ }
  assert.deepEqual(src.calls, [[1, 10_000], [10_001, 20_000], [20_001, 25_000]]);
  assert.equal(store.accountByWallet(agent)!.balanceMicros, 1n);
});

test('a deposit for another wallet creates that account', async () => {
  const store = new Store(':memory:');
  const newAgent = '0x' + 'ef'.repeat(20);
  store.applyDeposits('v', [ev(100, 0, 3n, newAgent)], 100, 0);
  assert.equal(store.accountByWallet(newAgent)!.balanceMicros, 3n);
  assert.equal(store.accountByWallet(human), undefined);
});
