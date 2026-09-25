// The control plane, as the app uses it. Every message the wallet signs is
// rebuilt here and compared with what the server sent; the app signs nothing else.

import { CONTROL } from './config.ts';

const lines = (...l: string[]) => l.join('\n');
export const manageMessage = (wallet: string, nonce: string, issuedAt: string) =>
  lines('envolvr: sign in to manage this account.', '', `Wallet: ${wallet.toLowerCase()}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`);
export const closeMessage = (wallet: string, refundTo: string, nonce: string, issuedAt: string) =>
  lines('envolvr: close this account and refund its balance.', '', `Wallet: ${wallet.toLowerCase()}`,
    `Refund to: ${refundTo.toLowerCase()}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`);

async function call<T>(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`, {
    method,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

type Sign = (message: string) => Promise<string>;

export async function startSession(wallet: string, sign: Sign): Promise<{ session: string; expiresAt: number }> {
  const n = await call<{ nonce: string; issuedAt: string; message: string }>('GET', `/auth/session/nonce?wallet=${wallet}`);
  const expected = manageMessage(wallet, n.nonce, n.issuedAt);
  if (n.message !== expected) throw new Error('unexpected message from the server; not signing it');
  return call('POST', '/auth/session', { body: { wallet, nonce: n.nonce, issuedAt: n.issuedAt, signature: await sign(expected) } });
}

export const endSession = (token: string) => call('POST', '/auth/session/end', { token, body: {} });

export interface Account { wallet: string; balanceMicros: string; allowanceTodayMicros: string; allowanceLeftMicros: string }
export const account = (token: string) => call<Account>('GET', '/account', { token });
export const pricing = () => call<{ depositFeeBps: number; tokenPricing: string }>('GET', '/pricing');

export interface Key { id: string; label: string | null; hint: string | null; createdAt: number; revokedAt: number | null }
export const keys = (token: string) => call<{ keys: Key[] }>('GET', '/account/keys', { token }).then((r) => r.keys);
export const createKey = (token: string, label?: string) =>
  call<{ apiKey: string; id: string; label: string | null }>('POST', '/account/keys', { token, body: label ? { label } : {} });
export const revokeKey = (token: string, id: string) => call('POST', '/account/keys/revoke', { token, body: { id } });

export interface Usage {
  at: number; requestId: string; model: string; route: string | null; status: number;
  costMicros: string; fromAllowanceMicros: string; fromBalanceMicros: string;
}
export const usage = (token: string) => call<{ usage: Usage[] }>('GET', '/account/usage?limit=100', { token }).then((r) => r.usage);

export interface Deposit { txHash: string; logIndex: number; amountMicros: string; feeMicros: string; held: boolean; blockNumber: number }
export const deposits = (token: string) => call<{ deposits: Deposit[] }>('GET', '/account/deposits', { token }).then((r) => r.deposits);

export async function closeAccount(wallet: string, refundTo: string, sign: Sign) {
  const n = await call<{ nonce: string; issuedAt: string; refundTo: string; message: string }>(
    'GET', `/account/close/nonce?wallet=${wallet}&refundTo=${refundTo}`);
  const expected = closeMessage(wallet, refundTo, n.nonce, n.issuedAt);
  if (n.message !== expected) throw new Error('unexpected message from the server; not signing it');
  return call<{ closed: boolean; revokedKeys: number; refund?: { id: number; amountMicros: string; status: string; refundTo: string } }>(
    'POST', '/account/close', { body: { wallet, refundTo, nonce: n.nonce, issuedAt: n.issuedAt, signature: await sign(expected) } });
}
