import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressOf, closeAccountMessage, hashApiKey, personalSign, signInMessage } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { createControlServer } from '../src/server.ts';

const CONTROL = 'c'.repeat(40);
const ADMIN = 'a'.repeat(40);
const APP = 'https://envolvr.xyz';
const config: Config = {
  port: 0, dbPath: ':memory:', marginBps: 0, minAvailableMicros: 1000, blockedWallets: [], controlToken: CONTROL, adminToken: ADMIN,
  corsOrigins: [APP],
  models: { 'z-ai/glm-5.3': { routes: [{ upstream: 'redpill', inputCostPerToken: '0.0000014', outputCostPerToken: '0.0000044' }] } },
};
let server: Server;
let base: string;
let store: Store;

before(async () => {
  store = new Store(':memory:');
  server = createControlServer({ config, store, allowance: { allowanceMicros: async () => 0n } });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const call = async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any };
};

async function session(key: Uint8Array) {
  const wallet = addressOf(secp256k1.getPublicKey(key));
  const n = (await call('GET', `/auth/session/nonce?wallet=${wallet}`)).body;
  assert.match(n.message, /^envolvr: sign in to manage this account\./);
  const r = await call('POST', '/auth/session', { wallet, nonce: n.nonce, issuedAt: n.issuedAt, signature: personalSign(n.message, key) });
  assert.equal(r.status, 200);
  return { wallet, token: r.body.session as string };
}

test('a session manages keys: create with a label, list without the key, revoke', async () => {
  const { wallet, token } = await session(secp256k1.utils.randomPrivateKey());
  assert.match(token, /^envs_/);
  const created = await call('POST', '/account/keys', { label: 'trading agent' }, token);
  assert.equal(created.status, 200);
  const { apiKey, id } = created.body;
  assert.match(apiKey, /^envk_/);
  assert.equal(id, hashApiKey(apiKey).slice(0, 16));
  const keys = (await call('GET', '/account/keys', undefined, token)).body.keys;
  assert.deepEqual(keys.map((k: any) => [k.id, k.label, k.hint, k.revokedAt]), [[id, 'trading agent', `${apiKey.slice(0, 9)}…`, null]]);
  assert.ok(!JSON.stringify(keys).includes(apiKey), 'the key itself is never listed');
  assert.equal((await call('GET', '/account', undefined, apiKey)).body.wallet, wallet);
  assert.equal((await call('POST', '/account/keys/revoke', { id }, token)).status, 200);
  assert.equal((await call('GET', '/account', undefined, apiKey)).status, 401);
  assert.equal((await call('POST', '/account/keys/revoke', { id }, token)).status, 404, 'already revoked');
  assert.equal((await call('POST', '/account/keys', { label: 'x'.repeat(65) }, token)).status, 400);
});

test('a session cannot run inference, and an API key cannot manage the account', async () => {
  const { token } = await session(secp256k1.utils.randomPrivateKey());
  const consult = await call('POST', '/consult/pre', { apiKeyHash: hashApiKey(token), model: 'z-ai/glm-5.3' }, CONTROL);
  assert.deepEqual([consult.body.allow, consult.body.status], [false, 401]);
  const { apiKey } = (await call('POST', '/account/keys', {}, token)).body;
  assert.equal((await call('GET', '/account/keys', undefined, apiKey)).status, 401);
  assert.equal((await call('POST', '/account/keys', {}, apiKey)).status, 401);
});

test('one account cannot revoke another\'s key', async () => {
  const a = await session(secp256k1.utils.randomPrivateKey());
  const b = await session(secp256k1.utils.randomPrivateKey());
  const { apiKey, id } = (await call('POST', '/account/keys', {}, a.token)).body;
  assert.equal((await call('POST', '/account/keys/revoke', { id }, b.token)).status, 404);
  assert.equal((await call('GET', '/account', undefined, apiKey)).status, 200);
});

test('a sign-in signature cannot start a session; an ended session stops working', async () => {
  const key = secp256k1.utils.randomPrivateKey();
  const wallet = addressOf(secp256k1.getPublicKey(key));
  const n = (await call('GET', `/auth/session/nonce?wallet=${wallet}`)).body;
  const wrong = personalSign(signInMessage(wallet, n.nonce, n.issuedAt), key);
  assert.equal((await call('POST', '/auth/session', { wallet, nonce: n.nonce, issuedAt: n.issuedAt, signature: wrong })).status, 401);
  const { token } = await session(key);
  assert.equal((await call('POST', '/auth/session/end', {}, token)).status, 200);
  assert.equal((await call('GET', '/account/keys', undefined, token)).status, 401);
});

test('closing the account ends its sessions', async () => {
  const key = secp256k1.utils.randomPrivateKey();
  const { wallet, token } = await session(key);
  const n = (await call('GET', `/account/close/nonce?wallet=${wallet}`)).body;
  const signature = personalSign(closeAccountMessage(wallet, n.refundTo, n.nonce, n.issuedAt), key);
  assert.equal((await call('POST', '/account/close', { wallet, refundTo: n.refundTo, nonce: n.nonce, issuedAt: n.issuedAt, signature })).status, 200);
  assert.equal((await call('GET', '/account/keys', undefined, token)).status, 401);
});

test('usage and deposits for the session\'s account', async () => {
  const { wallet, token } = await session(secp256k1.utils.randomPrivateKey());
  const account = store.accountByWallet(wallet)!;
  store.applyDeposits('v', [{
    txHash: '0x' + 'aa'.repeat(32), logIndex: 0, blockNumber: 7, account: wallet, payer: wallet, amountMicros: 10_000_000n, depositId: 1,
  }], 7, 1, () => false, 500);
  await call('POST', '/consult/post', {
    requestId: 'req-1', attemptIndex: 0, requestModel: 'z-ai/glm-5.3', selectedRouteId: 'redpill:z-ai/glm-5.3', status: 200,
    usage: { prompt_tokens: 100, completion_tokens: 10 }, userId: account.id,
  }, CONTROL);
  const usage = (await call('GET', '/account/usage?limit=10', undefined, token)).body.usage;
  assert.deepEqual(usage.map((u: any) => [u.requestId, u.model, u.route, u.costMicros, u.fromBalanceMicros]),
    [['req-1', 'z-ai/glm-5.3', 'redpill:z-ai/glm-5.3', '184', '184']]);
  const deposits = (await call('GET', '/account/deposits', undefined, token)).body.deposits;
  assert.deepEqual(deposits.map((d: any) => [d.amountMicros, d.feeMicros, d.held]), [['10000000', '500000', false]]);
});

test('CORS: only the app\'s origin, with preflight', async () => {
  const pre = await fetch(`${base}/account/keys`, { method: 'OPTIONS', headers: { origin: APP, 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), APP);
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/);
  const other = await call('GET', '/pricing', undefined, undefined, { origin: 'https://evil.example' });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const ok = await call('GET', '/pricing', undefined, undefined, { origin: APP });
  assert.equal(ok.headers.get('access-control-allow-origin'), APP);
});
