// Receipt batches for the ReceiptAnchor contract (contracts/src/ReceiptAnchor.sol).
//
// receiptDigest = SHA-256 of the receipt document's JCS bytes (RFC 8785),
//                 signature included.
// leaf          = keccak256(keccak256(receiptDigest)), matching the contract's
//                 keccak256(bytes.concat(keccak256(abi.encode(bytes32)))).
// inner node    = keccak256 of the two children in ascending order, as in
//                 OpenZeppelin MerkleProof.
// odd node      = a trailing node without a sibling is carried up unchanged,
//                 and its proof skips that level.

import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import canonicalize from 'canonicalize';

export type Hex = `0x${string}`;

export function toHex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}`;
}

export function fromHex(hex: string): Uint8Array {
  const bytes = hexToBytes(hex.startsWith('0x') ? hex.slice(2) : hex);
  if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
  return bytes;
}

export function receiptDigest(receipt: unknown): Hex {
  const jcs = canonicalize(receipt);
  if (jcs === undefined) throw new Error('receipt is not JSON-serializable');
  return toHex(sha256(utf8ToBytes(jcs)));
}

export function leafOf(digest: Hex): Uint8Array {
  return keccak_256(keccak_256(fromHex(digest)));
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  return compare(a, b) < 0 ? keccak_256(concatBytes(a, b)) : keccak_256(concatBytes(b, a));
}

function nextLevel(level: Uint8Array[]): Uint8Array[] {
  const next: Uint8Array[] = [];
  for (let i = 0; i + 1 < level.length; i += 2) next.push(hashPair(level[i], level[i + 1]));
  if (level.length % 2 === 1) next.push(level[level.length - 1]);
  return next;
}

export interface Batch {
  root: Hex;
  digests: Hex[];
  /** levels[0] holds the leaves, the last level holds the root. */
  levels: Uint8Array[][];
}

export function buildBatch(digests: Hex[]): Batch {
  if (digests.length === 0) throw new Error('a batch needs at least one receipt');
  const levels: Uint8Array[][] = [digests.map(leafOf)];
  while (levels[levels.length - 1].length > 1) levels.push(nextLevel(levels[levels.length - 1]));
  return { root: toHex(levels[levels.length - 1][0]), digests, levels };
}

export function proofFor(batch: Batch, index: number): Hex[] {
  if (index < 0 || index >= batch.digests.length) throw new Error(`no receipt at index ${index}`);
  const proof: Hex[] = [];
  for (const level of batch.levels.slice(0, -1)) {
    const sibling = index ^ 1;
    if (sibling < level.length) proof.push(toHex(level[sibling]));
    index = Math.floor(index / 2);
  }
  return proof;
}

export function verify(root: Hex, digest: Hex, proof: Hex[]): boolean {
  let node = leafOf(digest);
  for (const sibling of proof) node = hashPair(node, fromHex(sibling));
  return toHex(node) === root.toLowerCase();
}
