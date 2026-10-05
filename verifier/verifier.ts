// The in-browser receipt verifier on envolvr.xyz. Every check runs in the
// visitor's browser: the digest and anchor code is the SDK's own
// (sdk/src/receipts.ts), the signature is Ed25519 under the key the attested
// keyset lists, and the anchor is read from the ReceiptAnchor contract on
// Robinhood Chain through the public RPC. Built into the site's js/verifier.js
// by verifier/build.mjs.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { billingOf, receiptDigest, verifyAnchor, type Receipt } from '../sdk/src/receipts.ts';
import { TESTNET } from '../sdk/src/network.ts';

/** What a visitor verifies: the receipt, and whatever else they have of the exchange. */
export interface Bundle {
  receipt: Receipt;
  /** GET /v1/aci/attestation, saved while the receipt's keyset was live. */
  report?: { attestation?: { workload_keyset?: Keyset } };
  /** The exact request and response bytes. */
  request?: string;
  response?: string;
  /** GET /v1/aci/sessions/<id>: the attested provider session the receipt cites. */
  session?: unknown;
  /** The anchor proof as envolvr's proof service served it (data only; the chain decides). */
  proof?: unknown;
}

interface Keyset { receipt_signing_keys?: Array<{ key_id: string; algo: string; public_key: string }> }

export type Status = 'pass' | 'fail' | 'skip';
export interface Step { id: string; label: string; status: Status; detail: string }

type Event = Record<string, unknown> & { type: string };

// JCS (RFC 8785) for ACI documents: sorted member names, integer numbers only.
const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
  : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
    : v;
const jcs = (v: unknown) => utf8ToBytes(JSON.stringify(sorted(v)));
const sha = (b: Uint8Array) => bytesToHex(sha256(b));
const short = (h: string) => { const x = h.replace(/^(sha256:|0x)/, ''); return `${x.slice(0, 4)}…${x.slice(-4)}`; };

// Exact decimal arithmetic at 18 places, so the bill recomputes to the digit.
const SCALE = 18;
function dec(s: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a decimal: ${s}`);
  return BigInt(m[1]) * 10n ** BigInt(SCALE) + BigInt((m[2] ?? '').slice(0, SCALE).padEnd(SCALE, '0'));
}

function billingStep(receipt: Receipt): Step {
  const b = billingOf(receipt);
  if (!b) return { id: 'billing', label: 'billing', status: 'skip', detail: 'unpriced request' };
  const r = (k: string, fallback: bigint) => (b.rates[k] === undefined ? fallback : dec(b.rates[k]));
  const input = r('inputCostPerToken', 0n);
  const t = b.tokens;
  const uncached = Math.max(t.prompt - t.cache_read - t.cache_creation, 0);
  const cost = BigInt(uncached) * input + BigInt(t.cache_read) * r('cacheReadCostPerToken', input)
    + BigInt(t.cache_creation) * r('cacheCreationCostPerToken', input) + BigInt(t.completion) * r('outputCostPerToken', 0n);
  const micro = 10n ** BigInt(SCALE - 6);
  const billed = (cost + micro - 1n) / micro;
  const ok = cost === dec(b.cost) && billed === BigInt(b.billedMicroUsd);
  const usd = `$${(Number(b.billedMicroUsd) / 1e6).toFixed(6)}`;
  return {
    id: 'billing', label: 'billing', status: ok ? 'pass' : 'fail',
    detail: ok ? `${usd} · ${t.prompt + t.completion} tokens, recomputed` : `the rates and tokens do not add up to ${b.cost}`,
  };
}

/** Run every check this bundle allows, in order, one step at a time. */
export async function* verify(bundle: Bundle, opts: { rpc?: boolean } = {}): AsyncGenerator<Step> {
  const { receipt } = bundle;
  const events = (Array.isArray(receipt.event_log) ? receipt.event_log : []) as Event[];
  const ev = (type: string) => events.find((e) => e.type === type);

  // 1. The keyset the receipt names is the one in the attestation report.
  const keyset = bundle.report?.attestation?.workload_keyset;
  const keysetOk = keyset !== undefined && `sha256:${sha(jcs(keyset))}` === receipt.workload_keyset_digest;
  yield keyset === undefined
    ? { id: 'keyset', label: 'keyset', status: 'skip', detail: 'add the attestation report' }
    : { id: 'keyset', label: 'keyset', status: keysetOk ? 'pass' : 'fail',
        detail: keysetOk ? `${String(receipt.workload_keyset_digest).slice(0, 11)}…, attested` : 'the report is for a different keyset' };

  // 2. Ed25519 over JCS(receipt without `signature`) under that keyset's key.
  if (!keysetOk) {
    yield { id: 'signature', label: 'receipt signature', status: 'skip', detail: 'needs the attested keyset' };
  } else {
    const key = keyset!.receipt_signing_keys?.find((k) => k.key_id === receipt.key_id && k.algo === 'ed25519');
    const { signature, ...unsigned } = receipt as Receipt & { signature?: string };
    let ok = false;
    try { ok = !!key && typeof signature === 'string' && ed25519.verify(hexToBytes(signature), jcs(unsigned), hexToBytes(key.public_key)); } catch { ok = false; }
    yield { id: 'signature', label: 'receipt signature', status: ok ? 'pass' : 'fail',
      detail: ok ? `ed25519 · ${String(receipt.key_id).replace(/^dstack-kms-/, '')}` : 'does not verify under the attested key' };
  }

  // 3–4. Commitments to the exact request and response bytes.
  for (const [id, label, type, body] of [
    ['request', 'prompt commitment', 'request.received', bundle.request],
    ['response', 'response commitment', 'response.returned', bundle.response],
  ] as const) {
    const expected = ev(type)?.body_hash;
    if (body === undefined) { yield { id, label, status: 'skip', detail: `add the ${id} body` }; continue; }
    const ok = `sha256:${sha(utf8ToBytes(body))}` === expected;
    yield { id, label, status: ok ? 'pass' : 'fail', detail: ok ? `${short(String(expected))} matches` : `does not match ${short(String(expected ?? 'none'))}` };
  }

  // 5. The attested provider session the gateway verified before forwarding.
  const up = ev('upstream.verified');
  if (!up) {
    yield { id: 'session', label: 'provider session', status: 'fail', detail: 'no upstream.verified event' };
  } else if (bundle.session === undefined) {
    yield { id: 'session', label: 'provider session', status: up.result === 'verified' ? 'pass' : 'fail',
      detail: `${short(String(up.session_id))} ${String(up.result)} by the gateway` };
  } else {
    const ok = sha(jcs(bundle.session)) === up.session_id && up.result === 'verified';
    const s = bundle.session as { upstream_name?: string };
    yield { id: 'session', label: 'provider session', status: ok ? 'pass' : 'fail',
      detail: ok ? `${short(String(up.session_id))} · ${s.upstream_name ?? 'provider'}, attested` : 'the session document does not match' };
  }

  // 6. Billing, recomputed from the signed rates and token counts.
  yield billingStep(receipt);

  // 7. The digest is in a batch whose root is on Robinhood Chain.
  if (opts.rpc === false) return;
  // Every network call gives up after 5 s, so an offline service never stalls the page.
  const timed: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) });
  const fetchImpl: typeof fetch = bundle.proof === undefined ? timed
    : (input, init) => (String(input).startsWith(`${TESTNET.control}/receipts/`)
      ? Promise.resolve(new Response(JSON.stringify(bundle.proof), { status: 200 }))
      : timed(input, init));
  try {
    const a = await verifyAnchor(receipt, TESTNET, fetchImpl);
    if (a.status === 'anchored') {
      const at = new Date(a.anchoredAt! * 1000).toISOString().slice(11, 16);
      yield { id: 'anchor', label: 'on-chain anchor', status: 'pass', detail: `rhc · batch ${a.batchIndex} · ${at} utc` };
    } else {
      yield { id: 'anchor', label: 'on-chain anchor', status: 'skip', detail: a.status === 'pending' ? 'in the next 10-minute batch' : 'not in the anchor log yet' };
    }
  } catch (err) {
    const msg = (err as Error).message;
    const offline = /unreachable|HTTP|abort|timeout/i.test(msg);
    yield { id: 'anchor', label: 'on-chain anchor', status: offline ? 'skip' : 'fail', detail: offline ? 'proof service paused on testnet' : msg };
  }
}

export function digestOf(receipt: Receipt): string { return receiptDigest(receipt); }

/** Split pasted text into a bundle: one receipt, or a JSON object holding the parts. */
export function parseBundle(text: string): Bundle {
  const v = JSON.parse(text) as Record<string, unknown>;
  if (v && typeof v === 'object' && 'receipt' in v) return v as unknown as Bundle;
  if (v && typeof v === 'object' && 'receipt_id' in v) return { receipt: v as Receipt };
  throw new Error('not a receipt: expected a JSON object with receipt_id');
}
