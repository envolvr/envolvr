// Minimal EVM client for receipt anchoring: JSON-RPC, RLP, EIP-1559
// transactions signed with a secp256k1 key, and ABI encoding of static
// arguments. No dependencies beyond @noble.

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export type Hex = `0x${string}`;

export const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
export function unhex(h: string): Uint8Array {
  const s = h.replace(/^0x/, '');
  return hexToBytes(s.length % 2 ? `0${s}` : s);
}

/** Minimal big-endian bytes of a non-negative integer; zero is empty. */
export function uintBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('negative integer');
  if (n === 0n) return new Uint8Array();
  const h = n.toString(16);
  return hexToBytes(h.length % 2 ? `0${h}` : h);
}

type RlpItem = Uint8Array | RlpItem[];

export function rlp(item: RlpItem): Uint8Array {
  const length = (len: number, offset: number) => {
    if (len < 56) return Uint8Array.of(offset + len);
    const l = uintBytes(BigInt(len));
    return concatBytes(Uint8Array.of(offset + 55 + l.length), l);
  };
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concatBytes(length(item.length, 0x80), item);
  }
  const body = concatBytes(...item.map(rlp));
  return concatBytes(length(body.length, 0xc0), body);
}

export function addressOfKey(privateKey: Uint8Array): string {
  const pub = secp256k1.getPublicKey(privateKey, false);
  return hex(keccak_256(pub.slice(1)).slice(-20));
}

export interface Tx {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
  to: string;
  value: bigint;
  data: string;
}

/** Sign an EIP-1559 (type 2) transaction. Returns the raw bytes and the hash. */
export function signTx(tx: Tx, privateKey: Uint8Array): { raw: Hex; hash: Hex } {
  const fields: RlpItem[] = [
    uintBytes(tx.chainId), uintBytes(tx.nonce), uintBytes(tx.maxPriorityFeePerGas), uintBytes(tx.maxFeePerGas),
    uintBytes(tx.gas), unhex(tx.to), uintBytes(tx.value), unhex(tx.data), [],
  ];
  const digest = keccak_256(concatBytes(Uint8Array.of(2), rlp(fields)));
  const sig = secp256k1.sign(digest, privateKey);
  const raw = concatBytes(Uint8Array.of(2), rlp([...fields, uintBytes(BigInt(sig.recovery)), uintBytes(sig.r), uintBytes(sig.s)]));
  return { raw: hex(raw), hash: hex(keccak_256(raw)) };
}

export function selector(signature: string): string {
  return bytesToHex(keccak_256(utf8ToBytes(signature)).slice(0, 4));
}

/** ABI-encode a call whose arguments are all static words (bytes32, uintN, address). */
export function encodeCall(signature: string, args: (bigint | string)[]): Hex {
  const words = args.map((a) => (typeof a === 'bigint' ? a.toString(16) : a.replace(/^0x/, '').toLowerCase()).padStart(64, '0'));
  if (words.some((w) => w.length !== 64 || !/^[0-9a-f]+$/.test(w))) throw new Error(`bad argument for ${signature}`);
  return `0x${selector(signature)}${words.join('')}`;
}

/** The 32-byte words of an ABI return value. */
export function decodeWords(data: string): string[] {
  const h = data.replace(/^0x/, '');
  return Array.from({ length: Math.floor(h.length / 64) }, (_, i) => `0x${h.slice(i * 64, i * 64 + 64)}`);
}

export class RpcError extends Error {
  readonly data: string | undefined;

  constructor(message: string, data?: string) {
    super(message);
    this.data = data;
  }
}

export class Rpc {
  private url: string;
  private timeoutMs: number;

  constructor(url: string, timeoutMs = 20_000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string; data?: string } };
    if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.data);
    if (!res.ok || !('result' in body)) throw new RpcError(`${method} failed: HTTP ${res.status}`);
    return body.result as T;
  }
}
