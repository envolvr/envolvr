import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBatch, proofFor, receiptDigest, type Hex } from '../src/merkle.ts';
import { encodeVerifyReceipt, verifyAnchored, type AnchorTarget } from '../src/verify.ts';

const PROVIDER = '0x86b99987cd8f8ebddc2dd0efa61ed52b5db594430f12446db424da0d9c4b831f';
const target: AnchorTarget = {
  proofService: 'https://proofs.example', rpcUrl: 'https://rpc.example', chainId: 46630,
  contract: '0xff179938C830134D8E2922dAe7e16Ee4F0E33853', providerId: PROVIDER,
};
const receipt = JSON.parse(readFileSync(new URL('./fixtures/week0-receipt.json', import.meta.url), 'utf8'));
const digest = receiptDigest(receipt);
const others: Hex[] = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)] as Hex[];
const batch = buildBatch([others[0], digest, others[1]]);
const proof = proofFor(batch, 1);
const word = (v: bigint | string) => (typeof v === 'bigint' ? v.toString(16) : v.slice(2)).padStart(64, '0');

test('verifyReceipt calldata matches cast calldata', () => {
  // cast calldata 'verifyReceipt(bytes32,uint256,bytes32,bytes32[])' <PROVIDER> 3 <digest> '[0x11…,0x22…]'
  assert.equal(encodeVerifyReceipt(PROVIDER, 3, '0x358f0d33075793ed86c818d8371e9a39d873b4f361b6b426d967c45d1026db3f', others),
    '0xfb188cf786b99987cd8f8ebddc2dd0efa61ed52b5db594430f12446db424da0d9c4b831f'
    + '0000000000000000000000000000000000000000000000000000000000000003'
    + '358f0d33075793ed86c818d8371e9a39d873b4f361b6b426d967c45d1026db3f'
    + '0000000000000000000000000000000000000000000000000000000000000080'
    + '0000000000000000000000000000000000000000000000000000000000000002'
    + '11'.repeat(32) + '22'.repeat(32));
});

/** Proof service and RPC stubs; `chain` decides what the contract answers. */
function stub(opts: { proofStatus?: number; proofBody?: unknown; chainId?: number; chainRoot?: string; verifies?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.startsWith(target.proofService)) {
      calls.push('proof');
      const status = opts.proofStatus ?? 200;
      const body = opts.proofBody ?? {
        status: 'anchored', digest, batchIndex: 3, leafIndex: 1, count: 3, root: batch.root, proof, txHash: '0x' + 'ab'.repeat(32),
      };
      return new Response(JSON.stringify(body), { status });
    }
    const { method, params } = JSON.parse(String(init!.body));
    calls.push(method === 'eth_call' ? `call:${params[0].data.slice(0, 10)}` : method);
    if (method === 'eth_chainId') return Response.json({ result: `0x${(opts.chainId ?? 46630).toString(16)}` });
    const data: string = params[0].data;
    if (data.startsWith('0xfb188cf7')) {
      assert.equal(data, encodeVerifyReceipt(PROVIDER, 3, digest, proof));
      return Response.json({ result: `0x${word(opts.verifies === false ? 0n : 1n)}` });
    }
    // batch(bytes32,uint256): root, firstReceipt, count, anchoredAt
    return Response.json({ result: `0x${word(opts.chainRoot ?? batch.root)}${word(7n)}${word(3n)}${word(1790294404n)}` });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test('anchored: proof checked locally and by the contract, anchor time read from the chain', async () => {
  const { fetchImpl, calls } = stub();
  const r = await verifyAnchored(receipt, target, fetchImpl);
  assert.deepEqual({ status: r.status, batch: r.batchIndex, leaf: r.leafIndex, at: r.anchoredAt }, { status: 'anchored', batch: 3, leaf: 1, at: 1790294404 });
  assert.deepEqual(calls, ['proof', 'eth_chainId', 'call:0xacfc87ba', 'call:0xfb188cf7']); // batch(bytes32,uint256), then verifyReceipt
});

test('pending and unknown are reported, not failed', async () => {
  assert.equal((await verifyAnchored(receipt, target, stub({ proofBody: { status: 'pending', digest } }).fetchImpl)).status, 'pending');
  assert.equal((await verifyAnchored(receipt, target, stub({ proofStatus: 404, proofBody: { error: 'unknown' } }).fetchImpl)).status, 'unknown');
});

test('a wrong chain, a root the chain does not hold, a bad proof or a contract "false" all fail', async () => {
  await assert.rejects(verifyAnchored(receipt, target, stub({ chainId: 1 }).fetchImpl), /chain 1, expected 46630/);
  await assert.rejects(verifyAnchored(receipt, target, stub({ chainRoot: '0x' + '99'.repeat(32) }).fetchImpl), /on chain has root/);
  await assert.rejects(verifyAnchored(receipt, target, stub({ verifies: false }).fetchImpl), /returned false/);
  const forged = { status: 'anchored', digest, batchIndex: 3, leafIndex: 1, count: 3, root: batch.root, proof: [others[1]] };
  await assert.rejects(verifyAnchored(receipt, target, stub({ proofBody: forged }).fetchImpl), /does not lead to its root/);
});

test('an unreachable proof service says so', async () => {
  const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await assert.rejects(verifyAnchored(receipt, target, down), /proof service unreachable \(https:\/\/proofs\.example\)/);
});
