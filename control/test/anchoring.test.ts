import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes } from '@noble/hashes/utils';
import { Anchorer, type AnchorChain, type OnChainBatch } from '../src/anchoring.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { addressOfKey, encodeCall, hex, rlp, signTx, uintBytes, unhex } from '../src/evm.ts';
import { buildTree, proofFor, verifyProof, type Hex } from '../src/merkle.ts';
import { createControlServer } from '../src/server.ts';

// --- Encodings, pinned to Foundry's cast (see the commands in each comment) ---

const KEY = unhex('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
const ANCHOR = '0xff179938C830134D8E2922dAe7e16Ee4F0E33853';
const PROVIDER = '0x86b99987cd8f8ebddc2dd0efa61ed52b5db594430f12446db424da0d9c4b831f';
const VECTOR_ROOT = '0x2d6f32c5a43b671f25120af26b4db005c4ef0bb359ac0f25b1720e7c64e9bf92';

test('rlp matches cast to-rlp', () => {
  const b = (s: string) => new TextEncoder().encode(s);
  assert.equal(hex(rlp([b('cat'), b('dog')])), '0xc88363617483646f67');
  assert.equal(hex(rlp(new Uint8Array())), '0x80');
  assert.equal(hex(rlp(uintBytes(0n))), '0x80');
  assert.equal(hex(rlp(uintBytes(15n))), '0x0f');
  assert.equal(hex(rlp(uintBytes(1024n))), '0x820400');
  const long = new Uint8Array(56).fill(0x61);
  assert.equal(hex(rlp(long)).slice(0, 6), '0xb838');
});

test('anchor calldata matches cast calldata', () => {
  assert.equal(encodeCall('anchor(bytes32,uint256,bytes32,uint32)', [PROVIDER, 3n, VECTOR_ROOT, 5n]),
    '0xc4d0b61b86b99987cd8f8ebddc2dd0efa61ed52b5db594430f12446db424da0d9c4b831f'
    + '0000000000000000000000000000000000000000000000000000000000000003'
    + '2d6f32c5a43b671f25120af26b4db005c4ef0bb359ac0f25b1720e7c64e9bf92'
    + '0000000000000000000000000000000000000000000000000000000000000005');
});

test('a signed EIP-1559 transaction matches cast mktx byte for byte', () => {
  assert.equal(addressOfKey(KEY), '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23');
  const data = encodeCall('anchor(bytes32,uint256,bytes32,uint32)', [PROVIDER, 3n, VECTOR_ROOT, 5n]);
  const { raw, hash } = signTx({
    chainId: 46630n, nonce: 7n, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 20_000_000n, gas: 100_000n,
    to: ANCHOR, value: 0n, data,
  }, KEY);
  // cast mktx --private-key <KEY> --chain 46630 --nonce 7 --gas-limit 100000 --gas-price 20000000
  //   --priority-gas-price 1000000 <ANCHOR> 'anchor(bytes32,uint256,bytes32,uint32)' <PROVIDER> 3 <VECTOR_ROOT> 5
  assert.equal(raw, '0x02f8f182b62607830f42408401312d00830186a094ff179938c830134d8e2922dae7e16ee4f0e3385380b884'
    + data.slice(2)
    + 'c001a013c1c95691166c7e510164e549c2ffba721a91b8025ebc03cb88dbf34ae1af34a004217db2fa5d38b333deeed32bf4f2fa7db6e2642fbbe99941f57b5ec3eaca87');
  assert.equal(hash, hex(keccak_256(unhex(raw))));
});

// Digests i = keccak256(abi.encode(uint256 seed, uint256 i)), as in anchorer and Solidity tests.
function vectorDigests(seed: bigint, n: number): Hex[] {
  const w = (v: bigint) => unhex(v.toString(16).padStart(64, '0'));
  return Array.from({ length: n }, (_, i) => hex(keccak_256(concatBytes(w(seed), w(BigInt(i))))));
}

test('Merkle tree: the cross-implementation vector, and every member verifies up to 33 leaves', () => {
  assert.equal(buildTree(vectorDigests(42n, 5)).root, VECTOR_ROOT);
  for (let n = 1; n <= 33; n++) {
    const digests = vectorDigests(7n, n);
    const tree = buildTree(digests);
    digests.forEach((d, i) => assert.ok(verifyProof(tree.root, d, proofFor(tree, i)), `n=${n} i=${i}`));
  }
  const tree = buildTree(vectorDigests(42n, 5));
  assert.equal(verifyProof(tree.root, vectorDigests(43n, 1)[0], proofFor(tree, 0)), false);
});

// --- The anchoring loop, against an in-memory ReceiptAnchor ---

class FakeChain implements AnchorChain {
  readonly address = '0x00000000000000000000000000000000000000aa';
  registered = this.address;
  batches: { root: string; count: number; anchoredAt: number }[] = [];
  txs = new Map<string, { index: number; root: string; count: number; mined: boolean; success: boolean }>();
  /** Transactions sent but not mined until `mine()`. */
  autoMine = true;
  failSend = false;
  sent = 0;
  time = 0;

  async anchorer() { return this.registered; }
  async batchCount() { return this.batches.length; }
  async batch(index: number): Promise<OnChainBatch> {
    const b = this.batches[index];
    if (!b) throw new Error('NoSuchBatch');
    return { root: b.root, anchoredAt: b.anchoredAt };
  }
  async send(index: number, root: string, count: number) {
    if (this.failSend) throw new Error('rpc down');
    const hash = `0x${(++this.sent).toString(16).padStart(64, '0')}`;
    this.txs.set(hash, { index, root, count, mined: false, success: false });
    if (this.autoMine) this.mine(hash);
    return hash;
  }
  mine(hash: string) {
    const tx = this.txs.get(hash)!;
    tx.mined = true;
    tx.success = tx.index === this.batches.length; // the contract's batchIndex check
    if (tx.success) this.batches.push({ root: tx.root, count: tx.count, anchoredAt: this.time });
  }
  async receipt(hash: string) {
    const tx = this.txs.get(hash);
    return tx?.mined ? { success: tx.success, blockNumber: 100 + this.sent } : null;
  }
  async balance() { return 10n ** 18n; }
}

const INTERVAL = 600_000;
const SLOT0 = Date.parse('2026-09-25T12:00:00Z');
let store: Store;
let chain: FakeChain;
let clock: number;

beforeEach(() => {
  store = new Store(':memory:');
  chain = new FakeChain();
  clock = SLOT0 + 60_000;
});

const anchorer = () => new Anchorer(store, chain, {
  intervalMs: INTERVAL, resendAfterMs: 120_000, confirmWaitMs: 10_000,
  now: () => clock, sleep: async (ms) => { clock += ms; }, log: () => {},
});
const add = (digests: string[]) => store.addReceiptDigests(digests, Math.floor(clock / 1000));

test('one batch per slot, holding only digests received before the slot began', async () => {
  const a = anchorer();
  const first = vectorDigests(1n, 3);
  add(first);
  assert.equal(await a.tick(), 'idle', 'the slot these arrived in has not ended');
  clock = SLOT0 + INTERVAL + 5_000; // next slot
  add(vectorDigests(2n, 2)); // arrive in the new slot: not in this batch
  assert.equal(await a.tick(), 'anchored');
  assert.equal(chain.batches.length, 1);
  assert.equal(chain.batches[0].root, buildTree(first).root);
  assert.equal(chain.batches[0].count, 3);
  assert.equal(await a.tick(), 'idle', 'no second batch in the same slot');
  clock = SLOT0 + 2 * INTERVAL + 1_000;
  assert.equal(await a.tick(), 'anchored');
  assert.equal(chain.batches.length, 2);
  assert.equal(chain.batches[1].count, 2);
  clock += INTERVAL;
  assert.equal(await a.tick(), 'idle', 'an empty slot anchors nothing');
  assert.equal(chain.sent, 2);
});

test('a digest sent twice is kept once', () => {
  const [d] = vectorDigests(3n, 1);
  assert.equal(add([d, d]), 1);
  assert.equal(add([d]), 0);
});

test('a transaction that never lands is sent again, and the batch lands once', async () => {
  add(vectorDigests(4n, 2));
  clock = SLOT0 + INTERVAL;
  chain.autoMine = false;
  const a = anchorer();
  assert.equal(await a.tick(), 'sent');
  assert.equal(await a.tick(), 'waiting', 'within the resend window');
  clock += 130_000;
  assert.equal(await a.tick(), 'sent', 'past the window: resent');
  assert.equal(chain.sent, 2);
  chain.mine('0x' + '1'.padStart(64, '0'));
  chain.mine('0x' + '2'.padStart(64, '0')); // the resend hits the index check and reverts
  assert.equal(await a.tick(), 'anchored');
  assert.equal(chain.batches.length, 1);
  assert.equal(store.batch(0)?.anchoredAt, chain.time);
});

test('a failed send leaves the batch open and it is retried', async () => {
  add(vectorDigests(5n, 1));
  clock = SLOT0 + INTERVAL;
  chain.failSend = true;
  const a = anchorer();
  await assert.rejects(a.tick(), /rpc down/);
  assert.equal(store.openBatch()?.batchIndex, 0);
  chain.failSend = false;
  assert.equal(await a.tick(), 'anchored');
});

test('restored ledger: an index already taken on chain is dissolved and re-batched after it', async () => {
  const digests = vectorDigests(6n, 3);
  add(digests);
  clock = SLOT0 + INTERVAL;
  store.createBatch(0, buildTree(digests).root, digests, Math.floor(clock / 1000)); // built, never sent
  chain.batches.push({ root: '0x' + 'ee'.repeat(32), count: 9, anchoredAt: 1 }); // the chain moved on
  const a = anchorer();
  assert.equal(await a.tick(), 'dissolved');
  assert.equal(store.openBatch(), undefined);
  assert.deepEqual(store.unbatchedDigests(10, Math.floor(clock / 1000) + 1), digests);
  clock += INTERVAL;
  assert.equal(await a.tick(), 'anchored');
  assert.equal(chain.batches.length, 2);
  assert.equal(store.batch(1)?.root, buildTree(digests).root);
});

test('restored ledger: a new batch starts at the chain count', async () => {
  chain.batches.push({ root: '0x' + '11'.repeat(32), count: 1, anchoredAt: 1 }, { root: '0x' + '22'.repeat(32), count: 1, anchoredAt: 2 });
  add(vectorDigests(8n, 1));
  clock = SLOT0 + INTERVAL;
  assert.equal(await anchorer().tick(), 'anchored');
  assert.equal(store.lastBatch()?.batchIndex, 2);
});

test('start: logs as JSON, warns when the key is not registered, anchors, and stops', async () => {
  chain.registered = '0x' + '00'.repeat(20);
  add(vectorDigests(11n, 2));
  clock = SLOT0 + INTERVAL;
  const lines: string[] = [];
  const a = new Anchorer(store, chain, {
    intervalMs: INTERVAL, now: () => clock, sleep: () => new Promise((r) => setImmediate(r)),
    log: (msg, fields) => lines.push(JSON.stringify({ msg, ...fields })),
  });
  const stop = a.start(1);
  for (let i = 0; i < 50 && !lines.some((l) => l.includes('receipt anchoring balance')); i++) {
    await new Promise((r) => setImmediate(r));
  }
  stop();
  assert.ok(lines.some((l) => l.includes('not registered')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('"receipt anchoring started"') && l.includes('"balanceWei":"1000000000000000000"')));
  assert.ok(lines.some((l) => l.includes('receipt batch anchored')));
  assert.equal(chain.batches.length, 1);
});

// --- HTTP: ingest and proofs ---

const CONTROL = 'c'.repeat(40);
const config: Config = {
  port: 0, dbPath: ':memory:', marginBps: 2000, minAvailableMicros: 1000, models: {}, blockedWallets: [],
  controlToken: CONTROL, adminToken: 'a'.repeat(40),
  anchoring: { receiptAnchor: ANCHOR, providerId: PROVIDER, chainId: 46630 },
};
let server: Server;
let base: string;
let httpStore: Store;

before(async () => {
  httpStore = new Store(':memory:');
  server = createControlServer({ config, store: httpStore, allowance: { allowanceMicros: async () => 0n } });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test('POST /receipts: gateway token, digest format, idempotent', async () => {
  const [d1, d2] = vectorDigests(9n, 2);
  assert.equal((await call('POST', '/receipts', { receipts: [{ digest: d1 }] })).status, 401);
  assert.equal((await call('POST', '/receipts', { receipts: [{ digest: d1.toUpperCase() }] }, CONTROL)).status, 400);
  assert.equal((await call('POST', '/receipts', { receipts: [{ receiptId: 'r' }] }, CONTROL)).status, 400);
  const ok = await call('POST', '/receipts', { receipts: [{ receiptId: 'a', digest: d1 }, { receiptId: 'b', digest: d2 }] }, CONTROL);
  assert.deepEqual(ok, { status: 200, body: { added: 2 } });
  assert.deepEqual((await call('POST', '/receipts', { receipts: [{ digest: d1 }] }, CONTROL)).body, { added: 0 });
});

test('GET /receipts/<digest>/proof: unknown, pending, then a proof that verifies', async () => {
  const digests = vectorDigests(10n, 5);
  assert.equal((await call('GET', `/receipts/${digests[3]}/proof`)).status, 404);
  assert.equal((await call('GET', '/receipts/0x12/proof')).status, 400);
  httpStore.addReceiptDigests(digests, 1);
  assert.deepEqual((await call('GET', `/receipts/${digests[3]}/proof`)).body, {
    status: 'pending', digest: digests[3], chainId: 46630, contract: ANCHOR, providerId: PROVIDER,
  });
  const tree = buildTree(digests);
  httpStore.createBatch(0, tree.root, digests, 2);
  assert.equal((await call('GET', `/receipts/${digests[3]}/proof`)).body.status, 'pending', 'built but not on chain');
  httpStore.batchSent(0, '0x' + 'ab'.repeat(32), 3);
  httpStore.batchAnchored(0, 4, 77);
  const { status, body } = await call('GET', `/receipts/${digests[3].toUpperCase().replace('0X', '0x')}/proof`);
  assert.equal(status, 200);
  assert.equal(body.status, 'anchored');
  assert.equal(body.batchIndex, 0);
  assert.equal(body.leafIndex, 3);
  assert.equal(body.root, tree.root);
  assert.equal(body.txHash, '0x' + 'ab'.repeat(32));
  assert.equal(body.anchoredAt, 4);
  assert.ok(verifyProof(body.root as string, digests[3], body.proof as string[]));
});
