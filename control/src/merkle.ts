// Receipt batch trees for ReceiptAnchor (contracts/src/ReceiptAnchor.sol). The
// same tree as anchorer/src/merkle.ts and contracts/test/MerkleHelper.sol; all
// three are pinned to one cross-implementation test vector.
//
// leaf       = keccak256(keccak256(receiptDigest))
// inner node = keccak256 of the two children in ascending order (OpenZeppelin)
// odd node   = carried up unchanged; its proof skips that level

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';

export type Hex = `0x${string}`;

const toHex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;

function word(hex: string): Uint8Array {
  const b = hexToBytes(hex.replace(/^0x/, ''));
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return b;
}

export const leafOf = (digest: string) => keccak_256(keccak_256(word(digest)));

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? keccak_256(concatBytes(a, b)) : keccak_256(concatBytes(b, a));
  }
  return keccak_256(concatBytes(a, b));
}

export interface Tree {
  root: Hex;
  /** levels[0] holds the leaves, the last level the root. */
  levels: Uint8Array[][];
}

export function buildTree(digests: string[]): Tree {
  if (digests.length === 0) throw new Error('a batch needs at least one receipt');
  const levels = [digests.map(leafOf)];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) next.push(hashPair(level[i], level[i + 1]));
    if (level.length % 2 === 1) next.push(level[level.length - 1]);
    levels.push(next);
  }
  return { root: toHex(levels[levels.length - 1][0]), levels };
}

export function proofFor(tree: Tree, index: number): Hex[] {
  if (index < 0 || index >= tree.levels[0].length) throw new Error(`no leaf at index ${index}`);
  const proof: Hex[] = [];
  for (const level of tree.levels.slice(0, -1)) {
    if ((index ^ 1) < level.length) proof.push(toHex(level[index ^ 1]));
    index >>= 1;
  }
  return proof;
}

export function verifyProof(root: string, digest: string, proof: string[]): boolean {
  let node = leafOf(digest);
  for (const sibling of proof) node = hashPair(node, word(sibling));
  return toHex(node) === root.toLowerCase();
}
