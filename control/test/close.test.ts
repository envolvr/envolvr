import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressOf, personalSign, signInMessage } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Screening, type SanctionsSource } from '../src/screening.ts';
import { createControlServer } from '../src/server.ts';

const ADMIN = 'a'.repeat(40);
const config: Config = {
  port: 0, dbPath: ':memory:', marginBps: 0, minAvailableMicros: 1000, blockedWallets: [], models: {},
  controlToken: 'c'.repeat(40), adminToken: ADMIN,
};

async function withServer(flag: (wallet: string) => boolean | Error, fn: (base: string, store: Store) => Promise<void>) {
  const store = new Store(':memory:');
  const source: SanctionsSource = {
    name: 'stub',
    isSanctioned: async (w) => { const r = flag(w); if (r instanceof Error) throw r; return r; },
  };
  const server = createControlServer({
    config, store, screening: new Screening(store, { sources: [source] }), allowance: { allowanceMicros: async () => 0n },
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, store);
  } finally {
    server.close();
  }
}

const post = (base: string, path: string, body: unknown, token?: string) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

async function signIn(base: string, key: Uint8Array): Promise<{ wallet: string; apiKey: string }> {
  const wallet = addressOf(secp256k1.getPublicKey(key));
  const n = await (await fetch(`${base}/auth/nonce?wallet=${wallet}`)).json() as { nonce: string; issuedAt: string; message: string };
  const res = await post(base, '/auth/key', { wallet, nonce: n.nonce, issuedAt: n.issuedAt, signature: personalSign(n.message, key) });
  return res.json() as Promise<{ wallet: string; apiKey: string }>;
}

async function closeRequest(base: string, key: Uint8Array, refundTo?: string) {
  const wallet = addressOf(secp256k1.getPublicKey(key));
  const q = refundTo ? `&refundTo=${refundTo}` : '';
  const n = await (await fetch(`${base}/account/close/nonce?wallet=${wallet}${q}`)).json() as
    { nonce: string; issuedAt: string; refundTo: string; message: string };
  return { wallet, n, body: { wallet, refundTo: n.refundTo, nonce: n.nonce, issuedAt: n.issuedAt, signature: personalSign(n.message, key) } };
}

test('closing revokes every key and turns the balance into a pending refund to the address named', async () => {
  await withServer(() => false, async (base, store) => {
    const key = secp256k1.utils.randomPrivateKey();
    const { wallet, apiKey } = await signIn(base, key);
    const second = await signIn(base, key);
    await post(base, '/admin/credit', { wallet, amountMicros: '2000000' }, ADMIN);
    const refundTo = '0x' + '77'.repeat(20);
    const { n, body } = await closeRequest(base, key, refundTo);
    assert.match(n.message, new RegExp(`Refund to: ${refundTo}`));
    const res = await post(base, '/account/close', body);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      closed: true, revokedKeys: 2, refund: { id: 1, amountMicros: '2000000', status: 'pending', refundTo },
    });
    for (const k of [apiKey, second.apiKey]) {
      assert.equal((await fetch(`${base}/account`, { headers: { authorization: `Bearer ${k}` } })).status, 401);
    }
    assert.equal(store.accountByWallet(wallet)?.balanceMicros, 0n);
    assert.equal((await post(base, '/account/close', body)).status, 401, 'the nonce is spent');

    const pending = await (await fetch(`${base}/admin/refunds?status=pending`, { headers: { authorization: `Bearer ${ADMIN}` } })).json() as
      { refunds: { id: number; refundTo: string; amountMicros: string }[] };
    assert.deepEqual(pending.refunds.map((r) => [r.id, r.refundTo, r.amountMicros]), [[1, refundTo, '2000000']]);
    const tx = '0x' + 'ab'.repeat(32);
    assert.equal((await post(base, '/admin/refunds/paid', { id: 1, txHash: tx }, ADMIN)).status, 200);
    assert.equal((await post(base, '/admin/refunds/paid', { id: 1, txHash: tx }, ADMIN)).status, 409, 'paid once');
    assert.equal(store.refunds('paid')[0].txHash, tx);
    assert.equal((await fetch(`${base}/admin/refunds`)).status, 401);
  });
});

test('the refund defaults to the wallet; an empty balance closes without a refund', async () => {
  await withServer(() => false, async (base) => {
    const key = secp256k1.utils.randomPrivateKey();
    const { wallet } = await signIn(base, key);
    const { body } = await closeRequest(base, key);
    assert.equal(body.refundTo, wallet);
    assert.deepEqual(await (await post(base, '/account/close', body)).json(), { closed: true, revokedKeys: 1 });
  });
});

test('a sign-in signature cannot close an account, and a signature must be the wallet\'s', async () => {
  await withServer(() => false, async (base) => {
    const key = secp256k1.utils.randomPrivateKey();
    const { wallet } = await signIn(base, key);
    const { body } = await closeRequest(base, key);
    const signInSig = personalSign(signInMessage(wallet, body.nonce, body.issuedAt), key);
    assert.equal((await post(base, '/account/close', { ...body, signature: signInSig })).status, 401);
    const other = secp256k1.utils.randomPrivateKey();
    const forged = personalSign((await closeRequest(base, key)).n.message, other);
    assert.equal((await post(base, '/account/close', { ...body, signature: forged })).status, 401);
    assert.equal((await post(base, '/account/close', { ...body, refundTo: '0x' + '66'.repeat(20) })).status, 401,
      'the refund address is part of what was signed');
  });
});

test('a flagged wallet or refund address holds the refund; admin can release it', async () => {
  const flaggedTo = '0x' + '99'.repeat(20);
  await withServer((w) => w === flaggedTo, async (base, store) => {
    const key = secp256k1.utils.randomPrivateKey();
    const { wallet } = await signIn(base, key);
    await post(base, '/admin/credit', { wallet, amountMicros: '500000' }, ADMIN);
    const { body } = await closeRequest(base, key, flaggedTo);
    const res = await (await post(base, '/account/close', body)).json() as { refund: { id: number; status: string } };
    assert.equal(res.refund.status, 'held');
    assert.equal(store.refunds('pending').length, 0);
    assert.equal((await post(base, '/admin/refunds/release', { id: res.refund.id }, ADMIN)).status, 200);
    assert.equal(store.refunds('pending').length, 1);
  });
});

test('closing while screening is down answers 503 and the request can be retried', async () => {
  let down = true;
  await withServer(() => (down ? new Error('down') : false), async (base) => {
    const key = secp256k1.utils.randomPrivateKey();
    down = false;
    await signIn(base, key);
    down = true;
    // The wallet's result is cached from sign-in; the refund address is new, so it needs a lookup.
    const { body } = await closeRequest(base, key, '0x' + '55'.repeat(20));
    assert.equal((await post(base, '/account/close', body)).status, 503);
    down = false;
    assert.equal((await post(base, '/account/close', body)).status, 200, 'same signed request, retried');
  });
});
