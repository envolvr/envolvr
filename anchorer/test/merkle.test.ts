import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes } from '@noble/hashes/utils';
import { buildBatch, proofFor, receiptDigest, toHex, verify, type Hex } from '../src/merkle.ts';

// Digests i = keccak256(abi.encode(uint256 seed, uint256 i)), the same inputs the
// Solidity cross-check uses (contracts/test/ReceiptAnchor.t.sol, test vector test).
function vectorDigests(seed: bigint, n: number): Hex[] {
  const word = (v: bigint) => {
    const out = new Uint8Array(32);
    for (let i = 31; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
    return out;
  };
  return Array.from({ length: n }, (_, i) => toHex(keccak_256(concatBytes(word(seed), word(BigInt(i))))));
}

test('every member verifies, for every tree size up to 33', () => {
  for (let n = 1; n <= 33; n++) {
    const batch = buildBatch(vectorDigests(42n, n));
    batch.digests.forEach((d, i) => assert.ok(verify(batch.root, d, proofFor(batch, i)), `n=${n} i=${i}`));
  }
});

test('a non-member or a wrong root does not verify', () => {
  const batch = buildBatch(vectorDigests(42n, 5));
  const other = vectorDigests(43n, 1)[0];
  assert.equal(verify(batch.root, other, proofFor(batch, 0)), false);
  const otherRoot = buildBatch(vectorDigests(43n, 5)).root;
  assert.equal(verify(otherRoot, batch.digests[0], proofFor(batch, 0)), false);
});

test('a single-receipt batch has an empty proof', () => {
  const batch = buildBatch(vectorDigests(1n, 1));
  assert.deepEqual(proofFor(batch, 0), []);
  assert.ok(verify(batch.root, batch.digests[0], []));
});

test('receipt digest is SHA-256 over JCS, so key order does not matter', () => {
  const a = receiptDigest({ b: 1, a: { d: [1, 2], c: 'x' } });
  const b = receiptDigest({ a: { c: 'x', d: [1, 2] }, b: 1 });
  assert.equal(a, b);
});

test('cross-implementation vector: 5 receipts, seed 42', () => {
  // The same root is asserted in contracts/test/ReceiptAnchor.t.sol.
  const batch = buildBatch(vectorDigests(42n, 5));
  assert.equal(batch.root, VECTOR_ROOT_SEED42_N5);
});

test('a real gateway receipt builds and verifies', () => {
  const receipt = JSON.parse(
    readFileSync(new URL('./fixtures/week0-receipt.json', import.meta.url), 'utf8'),
  );
  const digest = receiptDigest(receipt);
  const batch = buildBatch([digest, ...vectorDigests(9n, 2)]);
  assert.ok(verify(batch.root, digest, proofFor(batch, 0)));
});

// Pinned on both sides.
const VECTOR_ROOT_SEED42_N5: Hex = '0x2d6f32c5a43b671f25120af26b4db005c4ef0bb359ac0f25b1720e7c64e9bf92';
