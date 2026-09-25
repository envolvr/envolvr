// The inference client. The gateway speaks the OpenAI API; this client adds
// what an agent needs to keep the proof: every response's receipt is fetched
// right away (the gateway keeps receipts for an hour) and saved with the exact
// request and response bytes and the attestation report of the keyset that
// signed it, so the receipt can be verified later, offline and on chain.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAccount, getPricing } from './api.ts';
import { auditReceipt, type AuditSummary, fetchAttestationReport, type PapResult, summarizeAudit } from './attest.ts';
import { type Network, TESTNET } from './network.ts';
import { type Anchor, billingOf, type Billing, chargedTo, type Receipt, verifyAnchor } from './receipts.ts';

export interface SavedReceipt {
  id: string;
  receipt: Receipt;
  /** Directory holding receipt.json, request.json, response.json. */
  dir?: string;
}

export interface Verification {
  receiptId: string;
  /** pap's offline audit: attestation report, receipt signature, commitments, cited session. */
  signature: PapResult | { verified: false; transcript: string };
  /** The audit read check by check; undefined when it did not run. */
  audit?: AuditSummary;
  billing?: Billing;
  /** Whether the receipt's payer commitment matches the API key given. */
  chargedToKey?: boolean;
  anchor: Anchor;
}

export class Envolvr {
  readonly network: Network;
  private apiKey: string;
  private receiptDir: string | undefined;

  constructor(opts: { apiKey: string; network?: Network; receiptDir?: string }) {
    this.apiKey = opts.apiKey;
    this.network = opts.network ?? TESTNET;
    this.receiptDir = opts.receiptDir;
  }

  /** Settings for the OpenAI SDK: `new OpenAI(envolvr.openai)`. Receipts are then yours to fetch. */
  get openai(): { baseURL: string; apiKey: string } {
    return { baseURL: `${this.network.gateway}/v1`, apiKey: this.apiKey };
  }

  account() {
    return getAccount(this.apiKey, this.network);
  }

  pricing() {
    return getPricing(this.network);
  }

  /** GET /v1/models: every model with its per-token prices and routes. */
  async models(): Promise<unknown> {
    const res = await fetch(`${this.network.gateway}/v1/models`, { headers: { authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new Error(`/v1/models: HTTP ${res.status}`);
    return res.json();
  }

  /**
   * A chat completion (non-streaming), with its receipt fetched and saved.
   * `body` is an OpenAI chat completion request; add `provider: { only: [...] }`
   * to pin providers.
   */
  async chat(body: Record<string, unknown>): Promise<{ response: any; receiptId: string | null; saved?: SavedReceipt }> {
    const request = JSON.stringify({ ...body, stream: false });
    const res = await fetch(`${this.network.gateway}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }, body: request,
    });
    const responseText = await res.text();
    const receiptId = res.headers.get('x-receipt-id');
    let response: any;
    try { response = JSON.parse(responseText); } catch { response = responseText; }
    if (!res.ok) {
      const message = typeof response === 'object' ? response?.error?.message : responseText;
      throw Object.assign(new Error(`chat completion: HTTP ${res.status} ${message ?? ''}`.trim()), { status: res.status, receiptId });
    }
    const saved = receiptId ? await this.receipt(receiptId, { request, response: responseText }) : undefined;
    return { response, receiptId, saved };
  }

  /**
   * Fetch a receipt (within an hour of the response) and save it. With
   * `receiptDir`, the request and response bytes and the signing keyset's
   * attestation report are saved beside it.
   */
  async receipt(id: string, bodies: { request?: string; response?: string } = {}): Promise<SavedReceipt> {
    const res = await fetch(`${this.network.gateway}/v1/aci/receipts/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`receipt ${id}: HTTP ${res.status}${res.status === 404 ? ' (receipts are kept for an hour)' : ''}`);
    const raw = await res.text();
    const receipt = JSON.parse(raw) as Receipt;
    if (!this.receiptDir) return { id, receipt };
    const dir = join(this.receiptDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'receipt.json'), raw);
    if (bodies.request !== undefined) writeFileSync(join(dir, 'request.json'), bodies.request);
    if (bodies.response !== undefined) writeFileSync(join(dir, 'response.json'), bodies.response);
    await this.saveReport(String(receipt.workload_keyset_digest));
    await this.saveSession(receipt, dir);
    return { id, receipt, dir };
  }

  /** Keep the provider session the receipt cites (sessions, like receipts, expire). */
  private async saveSession(receipt: Receipt, dir: string): Promise<void> {
    const cited = receipt.event_log.find((e) => e.type === 'upstream.verified' && typeof e.session_id === 'string');
    if (!cited) return;
    const res = await fetch(`${this.network.gateway}/v1/aci/sessions/${cited.session_id}`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (res.ok) writeFileSync(join(dir, 'session.json'), await res.text());
  }

  /** Keep one attestation report per keyset, fetched while that keyset is live. */
  private async saveReport(keysetDigest: string): Promise<void> {
    const reports = join(this.receiptDir!, 'attestation');
    const file = join(reports, `${keysetDigest.replace(':', '-')}.json`);
    if (existsSync(file)) return;
    const { nonce, report } = await fetchAttestationReport(this.network);
    if (report.workload_keyset_digest !== keysetDigest) return; // the gateway restarted since; nothing to pair with
    mkdirSync(reports, { recursive: true });
    writeFileSync(file, JSON.stringify(report));
    writeFileSync(file.replace(/\.json$/, '.nonce'), nonce);
  }

  /**
   * Verify a saved receipt: signature and commitments (pap, against the saved
   * attestation report), what it billed and whether to this key, and its anchor
   * on Robinhood Chain.
   */
  async verify(dir: string, opts: { acceptCompose?: string[] } = {}): Promise<Verification> {
    return verifySaved(dir, { network: this.network, apiKey: this.apiKey, receiptDir: this.receiptDir, ...opts });
  }
}

/** Verify a receipt saved by Envolvr.receipt (a directory with receipt.json). */
export async function verifySaved(dir: string, opts: {
  network?: Network; apiKey?: string; receiptDir?: string; acceptCompose?: string[];
  /** Leave the signature to a separate `pap audit` run (for example where npx is unavailable). */
  skipSignature?: boolean;
}): Promise<Verification> {
  const network = opts.network ?? TESTNET;
  const receiptPath = join(dir, 'receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
  const reports = join(opts.receiptDir ?? join(dir, '..'), 'attestation');
  const reportPath = join(reports, `${String(receipt.workload_keyset_digest).replace(':', '-')}.json`);
  const signature = opts.skipSignature
    ? { verified: false as const, transcript: 'skipped' }
    : existsSync(reportPath)
    ? await auditReceipt({
      reportPath, receiptPath, acceptCompose: opts.acceptCompose,
      nonce: existsSync(reportPath.replace(/\.json$/, '.nonce')) ? readFileSync(reportPath.replace(/\.json$/, '.nonce'), 'utf8') : undefined,
      requestBodyPath: existsSync(join(dir, 'request.json')) ? join(dir, 'request.json') : undefined,
      responseBodyPath: existsSync(join(dir, 'response.json')) ? join(dir, 'response.json') : undefined,
      sessionPath: existsSync(join(dir, 'session.json')) ? join(dir, 'session.json') : undefined,
    })
    : { verified: false as const, transcript: `no attestation report for keyset ${String(receipt.workload_keyset_digest)} in ${reports}` };
  return {
    receiptId: receipt.receipt_id,
    signature,
    audit: typeof signature.transcript === 'object' ? summarizeAudit(signature as PapResult) : undefined,
    billing: billingOf(receipt),
    chargedToKey: opts.apiKey ? chargedTo(receipt, opts.apiKey) : undefined,
    anchor: await verifyAnchor(receipt, network),
  };
}

/** Saved receipt directories under `receiptDir`, oldest first. */
export function savedReceipts(receiptDir: string): string[] {
  if (!existsSync(receiptDir)) return [];
  return readdirSync(receiptDir).filter((d) => d !== 'attestation' && existsSync(join(receiptDir, d, 'receipt.json')))
    .map((d) => join(receiptDir, d)).sort();
}
