// Receipts: what each one says about billing, whether it was charged to you,
// and whether it is anchored on Robinhood Chain. Nothing here trusts envolvr:
// digests and commitments are computed locally, and the anchor is checked
// against the contract itself.

import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import canonicalize from 'canonicalize';
import type { Network } from './network.ts';

export type Receipt = Record<string, unknown> & { receipt_id: string; event_log: Array<Record<string, unknown>> };

/** SHA-256 of the receipt's JCS bytes (RFC 8785): the value that is anchored. */
export function receiptDigest(receipt: unknown): `0x${string}` {
  const jcs = canonicalize(receipt);
  if (jcs === undefined) throw new Error('receipt is not JSON');
  return `0x${createHash('sha256').update(jcs).digest('hex')}`;
}

export interface Billing {
  currency: string;
  /** Exact cost as a decimal string, e.g. "0.00014". */
  cost: string;
  /** What was debited: the cost rounded up to the next micro-USD. */
  billedMicroUsd: number;
  rates: Record<string, string>;
  tokens: { prompt: number; completion: number; cache_read: number; cache_creation: number };
  payer?: string;
}

/** The receipt's billing.charged event, or undefined for an unpriced request. */
export function billingOf(receipt: Receipt): Billing | undefined {
  const e = receipt.event_log.find((x) => x.type === 'billing.charged');
  if (!e) return undefined;
  return {
    currency: String(e.currency), cost: String(e.cost), billedMicroUsd: Number(e.billed_micro_usd),
    rates: e.rates as Record<string, string>, tokens: e.tokens as Billing['tokens'],
    payer: e.payer === undefined ? undefined : String(e.payer),
  };
}

/** The payer commitment a receipt charged to `apiKey` carries. */
export function payerCommitment(apiKey: string, receiptId: string): string {
  const keyHash = createHash('sha256').update(apiKey, 'utf8').digest('hex');
  return `sha256:${createHash('sha256').update(`billing.payer.v1:${keyHash}:${receiptId}`).digest('hex')}`;
}

export function chargedTo(receipt: Receipt, apiKey: string): boolean {
  return billingOf(receipt)?.payer === payerCommitment(apiKey, receipt.receipt_id);
}

// ---- anchoring ----

const leafOf = (digest: string) => keccak_256(keccak_256(hexToBytes(digest.replace(/^0x/, ''))));

function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? keccak_256(concatBytes(a, b)) : keccak_256(concatBytes(b, a));
  }
  return keccak_256(concatBytes(a, b));
}

/** Check an inclusion proof against a root (OpenZeppelin sorted-pair Merkle tree). */
export function proofLeadsToRoot(digest: string, proof: string[], root: string): boolean {
  let node = leafOf(digest);
  for (const sibling of proof) node = hashPair(node, hexToBytes(sibling.replace(/^0x/, '')));
  return `0x${bytesToHex(node)}` === root.toLowerCase();
}

const selector = (sig: string) => bytesToHex(keccak_256(utf8ToBytes(sig))).slice(0, 8);
const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '').toLowerCase()).padStart(64, '0');

export interface Anchor {
  status: 'anchored' | 'pending' | 'unknown';
  digest: string;
  batchIndex?: number;
  leafIndex?: number;
  count?: number;
  root?: string;
  txHash?: string | null;
  /** Unix seconds, read from the contract. */
  anchoredAt?: number;
}

/**
 * Is this receipt anchored? The proof comes from envolvr's proof service as
 * data only; the chain, contract and provider come from `network`, and the
 * contract itself is asked.
 */
export async function verifyAnchor(receipt: unknown, network: Network, fetchImpl: typeof fetch = fetch): Promise<Anchor> {
  const digest = receiptDigest(receipt);
  const url = `${network.control}/receipts/${digest}/proof`;
  const res = await fetchImpl(url).catch((err: Error) => {
    throw new Error(`proof service unreachable (${new URL(url).origin}): ${err.message}`);
  });
  if (res.status === 404) return { status: 'unknown', digest };
  if (!res.ok) throw new Error(`proof service answered HTTP ${res.status}`);
  const p = await res.json() as {
    status: string; batchIndex: number; leafIndex: number; count: number; root: string; proof: string[]; txHash?: string | null;
  };
  if (p.status !== 'anchored') return { status: 'pending', digest };
  if (!proofLeadsToRoot(digest, p.proof, p.root)) throw new Error('the proof does not lead to its root');

  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetchImpl(network.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await r.json() as { result?: string; error?: { message: string } };
    if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? `HTTP ${r.status}`}`);
    return body.result;
  };
  const chainId = Number(BigInt(await rpc('eth_chainId', [])));
  if (chainId !== network.chainId) throw new Error(`RPC is on chain ${chainId}, expected ${network.chainId}`);
  const call = (data: string) => rpc('eth_call', [{ to: network.receiptAnchor, data }, 'latest']);
  const batch = await call(`0x${selector('batch(bytes32,uint256)')}${word(network.providerId)}${word(BigInt(p.batchIndex))}`);
  const onChainRoot = `0x${batch.slice(2, 66)}`;
  if (onChainRoot.toLowerCase() !== p.root.toLowerCase()) {
    throw new Error(`batch ${p.batchIndex} on chain has root ${onChainRoot}, the proof claims ${p.root}`);
  }
  const verified = await call(`0x${selector('verifyReceipt(bytes32,uint256,bytes32,bytes32[])')}${word(network.providerId)}`
    + `${word(BigInt(p.batchIndex))}${word(digest)}${word(128n)}${word(BigInt(p.proof.length))}${p.proof.map(word).join('')}`);
  if (BigInt(verified) !== 1n) throw new Error('ReceiptAnchor.verifyReceipt returned false');
  return {
    status: 'anchored', digest, batchIndex: p.batchIndex, leafIndex: p.leafIndex, count: p.count, root: p.root,
    txHash: p.txHash ?? null, anchoredAt: Number(BigInt(`0x${batch.slice(194, 258)}`)),
  };
}
