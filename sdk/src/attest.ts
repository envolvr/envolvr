// Attestation: is this really envolvr's measured gateway, and did it sign this
// receipt? The checks are done by private-ai-proxy (pap), the open verifier for
// the ACI protocol the gateway speaks (TDX quote to Intel's root, keyset and
// nonce binding, source provenance, TLS channel binding, receipt signature,
// request and response commitments). This module runs it and reads its verdict.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Network } from './network.ts';

export const PAP_PACKAGE = 'private-ai-proxy@0.1.6';

export interface PapResult {
  /** True only when pap's verdict is VERIFIED (exit 0). */
  verified: boolean;
  /** pap's --json transcript, or its text output when that is not JSON. */
  transcript: unknown;
  stderr: string;
}

export function runPap(args: string[], opts: { timeoutMs?: number } = {}): Promise<PapResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['-y', PAP_PACKAGE, ...args, '--json', '--non-interactive'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 300_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`could not run ${PAP_PACKAGE} (needs npx): ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let transcript: unknown = stdout.trim();
      try { transcript = JSON.parse(stdout); } catch { /* keep the text */ }
      resolve({ verified: code === 0, transcript, stderr: stderr.trim() });
    });
  });
}

/**
 * Verify the live gateway: a fresh nonce, the TDX quote, the measured compose
 * and source, and the TLS key being served. `acceptCompose` pins the compose
 * hashes you accept; without it pap verifies and reports the measurement and
 * you appraise it yourself.
 */
export function verifyGateway(network: Network, opts: { acceptCompose?: string[] } = {}): Promise<PapResult> {
  return runPap(['verify', '--require-production-os',
    ...(opts.acceptCompose ?? []).flatMap((h) => ['--accept-compose', h]), network.gateway]);
}

/** A fresh 32-byte attestation nonce (64 lowercase hex). */
export const newNonce = () => randomBytes(32).toString('hex');

/** Fetch the gateway's attestation report for a nonce (to keep beside receipts). */
export async function fetchAttestationReport(network: Network, nonce = newNonce()): Promise<{ nonce: string; report: Record<string, unknown> }> {
  const res = await fetch(`${network.gateway}/v1/aci/attestation?nonce=${nonce}`);
  if (!res.ok) throw new Error(`attestation report: HTTP ${res.status}`);
  return { nonce, report: await res.json() as Record<string, unknown> };
}

/**
 * Check a saved receipt offline against the attestation report of the keyset
 * that signed it: the report itself (quote, binding, provenance), the receipt
 * signature, and, when given, the exact request and response bytes against the
 * receipt's commitments.
 */
export function auditReceipt(opts: {
  reportPath: string; nonce?: string; receiptPath: string; requestBodyPath?: string; responseBodyPath?: string;
  acceptCompose?: string[];
}): Promise<PapResult> {
  return runPap([
    'audit', '--report', opts.reportPath, '--receipt', opts.receiptPath, '--require-production-os', '--skip-expiry',
    ...(opts.nonce ? ['--nonce', opts.nonce] : []),
    ...(opts.requestBodyPath ? ['--request-body', opts.requestBodyPath] : []),
    ...(opts.responseBodyPath ? ['--response-body', opts.responseBodyPath] : []),
    ...(opts.acceptCompose ?? []).flatMap((h) => ['--accept-compose', h]),
  ]);
}
