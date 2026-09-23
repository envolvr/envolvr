import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressOf, hashApiKey, personalSign } from '../src/auth.ts';
import type { AllowanceSource } from '../src/chain.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { createControlServer } from '../src/server.ts';

const DAY = 86_400;
const D0 = 20_720 * DAY; // 2026-09-23
const CONTROL = 'c'.repeat(40);
const ADMIN = 'a'.repeat(40);

const config: Config = {
  port: 0, dbPath: ':memory:', upstreamName: 'redpill', marginBps: 2000, minAvailableMicros: 1000,
  models: { 'z-ai/glm-5.3': { inputCostPerToken: '0.0000014', outputCostPerToken: '0.0000044' } },
  blockedWallets: [], controlToken: CONTROL, adminToken: ADMIN,
};

const allowances = new Map<string, bigint>();
const allowance: AllowanceSource = { allowanceMicros: async (w, day) => allowances.get(`${w.toLowerCase()}:${day}`) ?? 0n };
let now = D0 + 10 * 3600;
let server: Server;
let base: string;
const blockedKey = secp256k1.utils.randomPrivateKey();

before(async () => {
  const cfg = { ...config, blockedWallets: [addressOf(secp256k1.getPublicKey(blockedKey))] };
  server = createControlServer({ config: cfg, store: new Store(':memory:'), allowance, now: () => now });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function signIn(privateKey: Uint8Array) {
  const wallet = addressOf(secp256k1.getPublicKey(privateKey));
  const { body: n } = await call('GET', `/auth/nonce?wallet=${wallet}`);
  const signature = personalSign(n.message, privateKey);
  return { wallet, nonce: n, signature, res: await call('POST', '/auth/key', { wallet, nonce: n.nonce, issuedAt: n.issuedAt, signature }) };
}

const pre = (apiKey: string | undefined, model = 'z-ai/glm-5.3') =>
  call('POST', '/consult/pre', { apiKeyHash: apiKey && hashApiKey(apiKey), model }, CONTROL);

test('gateway endpoints require the control token', async () => {
  assert.equal((await call('POST', '/consult/pre', {})).status, 401);
  assert.equal((await call('POST', '/consult/pre', {}, 'wrong')).status, 401);
  assert.equal((await call('GET', '/models/providers/redpill', undefined, CONTROL)).status, 200);
});

test('wallet sign-in issues a key; nonces are single use; wrong signers are refused', async () => {
  const key = secp256k1.utils.randomPrivateKey();
  const first = await signIn(key);
  assert.equal(first.res.status, 200);
  assert.match(first.res.body.apiKey, /^envk_/);

  const replay = await call('POST', '/auth/key', { wallet: first.wallet, nonce: first.nonce.nonce, issuedAt: first.nonce.issuedAt, signature: first.signature });
  assert.equal(replay.status, 401);

  const other = secp256k1.utils.randomPrivateKey();
  const { body: n } = await call('GET', `/auth/nonce?wallet=${first.wallet}`);
  const forged = await call('POST', '/auth/key', { wallet: first.wallet, nonce: n.nonce, issuedAt: n.issuedAt, signature: personalSign(n.message, other) });
  assert.equal(forged.status, 401);
});

test('screened wallets cannot get a key', async () => {
  assert.equal((await signIn(blockedKey)).res.status, 403);
});

test('pre-consult: unknown key, no credit, unknown model, then allowed with priced route', async () => {
  const key = secp256k1.utils.randomPrivateKey();
  const { wallet, res } = await signIn(key);
  const apiKey = res.body.apiKey as string;

  assert.deepEqual((await pre(undefined)).body, { allow: false, status: 401, message: 'missing API key' });
  assert.equal((await pre('envk_unknown')).body.status, 401);
  assert.deepEqual((await pre(apiKey)).body, { allow: false, status: 402, message: 'insufficient credit' });

  allowances.set(`${wallet}:${D0}`, 1_000_000n);
  assert.equal((await pre(apiKey, 'no/such-model')).body.status, 404);
  const ok = await pre(apiKey);
  assert.equal(ok.body.allow, true);
  assert.deepEqual(ok.body.pricing, { inputCostPerToken: '0.00000168', outputCostPerToken: '0.00000528' });
  assert.equal(ok.body.candidates[0].routeId, 'redpill:z-ai/glm-5.3');
  assert.ok(ok.body.userId > 0 && ok.body.userId === ok.body.organizationId && ok.body.userId === ok.body.workspaceId);
});

test('usage is billed to the allowance first, then the balance, exactly once', async () => {
  const key = secp256k1.utils.randomPrivateKey();
  const { wallet, res } = await signIn(key);
  const { body: consult } = await (async () => {
    allowances.set(`${wallet}:${D0}`, 1_000n);
    return pre(res.body.apiKey);
  })();
  assert.equal(consult.allow, true);
  await call('POST', '/admin/credit', { wallet, amountMicros: '5000' }, ADMIN);

  // 1000 in @ 1.68 + 100 out @ 5.28 micro-USD = 1680 + 528 = 2208 micro-USD.
  const report = {
    requestId: 'chatcmpl-1', endpoint: '/v1/chat/completions', status: 200, durationMs: 900, attemptIndex: 0,
    selectedRouteId: 'redpill:z-ai/glm-5.3', requestModel: 'z-ai/glm-5.3',
    usage: { prompt_tokens: 1000, completion_tokens: 100 }, pricing: consult.pricing, userId: consult.userId,
    organizationId: consult.organizationId, workspaceId: consult.workspaceId,
  };
  const billed = await call('POST', '/consult/post', report, CONTROL);
  assert.deepEqual(billed.body, { recorded: true, costMicros: '2208', fromAllowanceMicros: '1000', fromBalanceMicros: '1208' });
  const replay = await call('POST', '/consult/post', report, CONTROL);
  assert.equal(replay.body.recorded, false);

  const account = await call('GET', `/admin/account?wallet=${wallet}`, undefined, ADMIN);
  assert.equal(account.body.balanceMicros, '3792');
  assert.equal(account.body.allowanceLeftMicros, '0');

  // Next UTC day: a fresh allowance.
  now += DAY;
  allowances.set(`${wallet}:${D0 + DAY}`, 1_000n);
  assert.equal((await call('GET', `/admin/account?wallet=${wallet}`, undefined, ADMIN)).body.allowanceLeftMicros, '1000');
  now -= DAY;
});

test('failed attempts without usage cost nothing', async () => {
  const r = await call('POST', '/consult/post', {
    requestId: 'chatcmpl-2', endpoint: '/v1/chat/completions', status: 504, durationMs: 60000, attemptIndex: 0,
    selectedRouteId: 'redpill:z-ai/glm-5.3', requestModel: 'z-ai/glm-5.3', usage: null, pricing: null,
    errorSource: 'upstream', errorMessage: 'upstream_timeout',
  }, CONTROL);
  assert.deepEqual(r.body, { recorded: true, costMicros: '0', fromAllowanceMicros: '0', fromBalanceMicros: '0' });
});

test('admin endpoints require the admin token', async () => {
  assert.equal((await call('POST', '/admin/credit', { wallet: '0x' + '1'.repeat(40), amountMicros: '1' }, CONTROL)).status, 401);
});
