// Check that a receipt is anchored on chain, without trusting envolvr.
//
// 1. The digest is computed here from the receipt (SHA-256 of its JCS bytes).
// 2. The inclusion proof comes from envolvr's proof service, but only as data:
//    the contract, chain and provider are pinned by the caller (defaults from
//    contracts/deployments), never taken from the answer.
// 3. The proof is checked locally against its root, and the chain is asked
//    directly: the root stored at that batch index must match, and
//    ReceiptAnchor.verifyReceipt must return true.
//
// The receipt's signature and its binding to the request and response are the
// other half; `npx private-ai-proxy audit` checks those.

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { receiptDigest, verify, type Hex } from './merkle.ts';

export interface AnchorTarget {
  proofService: string;
  rpcUrl: string;
  chainId: number;
  contract: string;
  providerId: string;
}

export interface AnchorResult {
  digest: Hex;
  status: 'anchored' | 'pending' | 'unknown';
  batchIndex?: number;
  leafIndex?: number;
  count?: number;
  root?: string;
  txHash?: string | null;
  anchoredAt?: number;
}

const selector = (sig: string) => bytesToHex(keccak_256(utf8ToBytes(sig))).slice(0, 8);
const word = (v: string | bigint) =>
  (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '').toLowerCase()).padStart(64, '0');

export function encodeVerifyReceipt(providerId: string, batchIndex: number, digest: string, proof: string[]): string {
  // Static head, then the bytes32[] tail (offset 4 words, length, elements).
  return `0x${selector('verifyReceipt(bytes32,uint256,bytes32,bytes32[])')}${word(providerId)}${word(BigInt(batchIndex))}`
    + `${word(digest)}${word(128n)}${word(BigInt(proof.length))}${proof.map(word).join('')}`;
}

export async function verifyAnchored(receipt: unknown, target: AnchorTarget, fetchImpl: typeof fetch = fetch): Promise<AnchorResult> {
  const digest = receiptDigest(receipt);
  const proofUrl = `${target.proofService.replace(/\/$/, '')}/receipts/${digest}/proof`;
  const res = await fetchImpl(proofUrl).catch((err: Error) => {
    throw new Error(`proof service unreachable (${new URL(proofUrl).origin}): ${err.message}`);
  });
  if (res.status === 404) return { digest, status: 'unknown' };
  if (!res.ok) throw new Error(`proof service answered HTTP ${res.status}`);
  const p = await res.json() as {
    status: string; batchIndex: number; leafIndex: number; count: number; root: string; proof: string[];
    txHash?: string | null; anchoredAt?: number;
  };
  if (p.status !== 'anchored') return { digest, status: 'pending' };
  if (!verify(p.root as Hex, digest, p.proof as Hex[])) throw new Error('the proof does not lead to its root');

  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetchImpl(target.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await r.json() as { result?: string; error?: { message: string } };
    if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? `HTTP ${r.status}`}`);
    return body.result;
  };
  const chainId = Number(BigInt(await rpc('eth_chainId', [])));
  if (chainId !== target.chainId) throw new Error(`RPC is on chain ${chainId}, expected ${target.chainId}`);
  const call = (data: string) => rpc('eth_call', [{ to: target.contract, data }, 'latest']);
  const batch = await call(`0x${selector('batch(bytes32,uint256)')}${word(target.providerId)}${word(BigInt(p.batchIndex))}`);
  const onChainRoot = `0x${batch.slice(2, 66)}`;
  if (onChainRoot.toLowerCase() !== p.root.toLowerCase()) {
    throw new Error(`batch ${p.batchIndex} on chain has root ${onChainRoot}, the proof claims ${p.root}`);
  }
  const ok = await call(encodeVerifyReceipt(target.providerId, p.batchIndex, digest, p.proof));
  if (BigInt(ok) !== 1n) throw new Error('ReceiptAnchor.verifyReceipt returned false');
  return {
    digest, status: 'anchored', batchIndex: p.batchIndex, leafIndex: p.leafIndex, count: p.count, root: p.root,
    txHash: p.txHash ?? null, anchoredAt: Number(BigInt(`0x${batch.slice(194, 258)}`)),
  };
}
