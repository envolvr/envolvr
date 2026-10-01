import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { closeAccount, closeAccountMessage, depositUsdg, netCredit, signIn, signInMessage } from '../src/api.ts';
import { Envolvr, verifySaved } from '../src/client.ts';
import { addressOfKey, encodeCall, hex, personalSign, signTx, unhex } from '../src/evm.ts';
import { fromMicros, MAINNET, type Network, TESTNET, toMicros } from '../src/network.ts';
import type { TopUpEvent } from '../src/topup.ts';
import { billingOf, chargedTo, payerCommitment, receiptDigest, type Receipt } from '../src/receipts.ts';
import type { Signer } from '../src/wallet.ts';

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

// ---- vectors shared with the control plane, the gateway and Foundry ----

test('EIP-1559 signing matches cast mktx; personal_sign recovers to the signer', () => {
  const key = unhex(KEY);
  assert.equal(addressOfKey(key), '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23');
  const data = encodeCall('anchor(bytes32,uint256,bytes32,uint32)', [
    '0x86b99987cd8f8ebddc2dd0efa61ed52b5db594430f12446db424da0d9c4b831f', 3n,
    '0x2d6f32c5a43b671f25120af26b4db005c4ef0bb359ac0f25b1720e7c64e9bf92', 5n,
  ]);
  const { raw } = signTx({
    chainId: 46630n, nonce: 7n, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 20_000_000n, gas: 100_000n,
    to: '0xff179938C830134D8E2922dAe7e16Ee4F0E33853', value: 0n, data,
  }, key);
  assert.ok(raw.endsWith('c001a013c1c95691166c7e510164e549c2ffba721a91b8025ebc03cb88dbf34ae1af34a004217db2fa5d38b333deeed32bf4f2fa7db6e2642fbbe99941f57b5ec3eaca87'));
  const sig = hexToBytes(personalSign('hello', key).slice(2));
  const msg = utf8ToBytes('hello');
  const digest = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(sig[64] - 27).recoverPublicKey(digest);
  assert.equal(hex(keccak_256(pub.toRawBytes(false).slice(1)).slice(-20)), addressOfKey(key));
});

test('payer commitment: the vector the gateway pins', () => {
  assert.equal(payerCommitment('envk_test-key', 'rcpt-1'), 'sha256:cdae03a3662f631fabeb55bdc1c61bd1a2df2e4799d05cffc410f27ed7ca578e');
});

test('receipt digest: a production receipt, as the anchorer and gateway compute it', () => {
  const receipt = JSON.parse(readFileSync(new URL('../../anchorer/test/fixtures/week0-receipt.json', import.meta.url), 'utf8'));
  assert.equal(receiptDigest(receipt), '0x358f0d33075793ed86c818d8371e9a39d873b4f361b6b426d967c45d1026db3f');
});

test('amounts: USD with 6 decimals, and the net credit after the deposit fee', () => {
  assert.equal(toMicros('1.5'), 1_500_000n);
  assert.equal(toMicros('10'), 10_000_000n);
  assert.throws(() => toMicros('0.0000001'));
  assert.equal(fromMicros(9_500_000n), '9.5');
  assert.equal(fromMicros('191'), '0.000191');
  assert.equal(netCredit(10_000_000n, 500), 9_500_000n);
  assert.equal(netCredit(19n, 500), 19n);
});

test('billing and payer: read from the receipt, matched against the key', () => {
  const receipt: Receipt = {
    receipt_id: 'rcpt-1',
    event_log: [
      { type: 'request.received' },
      { type: 'billing.charged', currency: 'USD', cost: '0.00014', billed_micro_usd: 140,
        rates: { inputCostPerToken: '0.000001' }, tokens: { prompt: 100, completion: 20, cache_read: 0, cache_creation: 0 },
        payer: payerCommitment('envk_test-key', 'rcpt-1') },
      { type: 'response.returned' },
    ],
  };
  assert.deepEqual(billingOf(receipt)?.billedMicroUsd, 140);
  assert.equal(chargedTo(receipt, 'envk_test-key'), true);
  assert.equal(chargedTo(receipt, 'envk_other'), false);
  assert.equal(billingOf({ receipt_id: 'r', event_log: [] }), undefined);
});

// ---- the API, against stub servers ----

let server: Server;
let base: string;
const state = {
  tamper: false, txs: [] as { to: string; data: string }[], allowance: 0n, balance: 50_000_000n,
  // the account at the control plane: its balance, reads counted; chat answers 402 below `need`
  account: { wallet: '', balanceMicros: 0n, reads: 0 }, need: 0n,
};
const RECEIPT = {
  api_version: 'aci/1', receipt_id: 'rcpt-9', workload_keyset_digest: 'sha256:' + 'ab'.repeat(32), key_id: 'k', signature: '00',
  event_log: [{ type: 'billing.charged', currency: 'USD', cost: '0.0003', billed_micro_usd: 300, rates: {}, tokens: { prompt: 1, completion: 1, cache_read: 0, cache_creation: 0 }, payer: payerCommitment('envk_agent', 'rcpt-9') }],
};

before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(typeof value === 'string' ? value : JSON.stringify(value));
    if (url.pathname === '/auth/nonce') {
      const wallet = url.searchParams.get('wallet')!;
      const message = signInMessage(wallet, 'n1', '2026-09-25T00:00:00.000Z');
      return send(200, { nonce: 'n1', issuedAt: '2026-09-25T00:00:00.000Z', message: state.tamper ? `${message}\nTransfer: everything` : message });
    }
    if (url.pathname === '/auth/key') return send(200, { apiKey: `envk_for_${body.signature.slice(2, 10)}`, wallet: body.wallet.toLowerCase() });
    if (url.pathname === '/account/close/nonce') {
      const wallet = url.searchParams.get('wallet')!;
      const refundTo = url.searchParams.get('refundTo')!;
      const message = closeAccountMessage(wallet, refundTo, 'n2', '2026-09-25T00:00:00.000Z');
      return send(200, { nonce: 'n2', issuedAt: '2026-09-25T00:00:00.000Z', refundTo, message: state.tamper ? message.replace(refundTo.toLowerCase(), '0x' + 'ee'.repeat(20)) : message });
    }
    if (url.pathname === '/account/close') {
      return send(200, { closed: true, revokedKeys: 1, refund: { id: 1, amountMicros: '9500000', status: 'pending', refundTo: body.refundTo.toLowerCase() } });
    }
    if (url.pathname === '/pricing') return send(200, { depositFeeBps: 500, tokenPricing: 'provider list price' });
    if (url.pathname === '/account') {
      state.account.reads++;
      return send(200, { wallet: state.account.wallet, balanceMicros: String(state.account.balanceMicros), allowanceTodayMicros: '0', allowanceLeftMicros: '0' });
    }
    if (url.pathname === '/rpc') {
      const { method, params } = body;
      if (method === 'eth_call') {
        const sel = params[0].data.slice(0, 10);
        const v = sel === encodeCall('balanceOf(address)', ['0x' + '00'.repeat(20)]).slice(0, 10) ? state.balance : state.allowance;
        return send(200, { result: `0x${v.toString(16).padStart(64, '0')}` });
      }
      return send(400, { error: { message: `unexpected ${method}` } });
    }
    if (url.pathname === '/v1/chat/completions') {
      assert.equal(req.headers.authorization, 'Bearer envk_agent');
      if (state.account.balanceMicros < state.need) return send(402, { error: { message: 'insufficient credit' } });
      return send(200, { choices: [{ message: { content: 'sealed' } }], usage: { cost: 0.0003 } }, { 'x-receipt-id': 'rcpt-9' });
    }
    if (url.pathname === '/v1/aci/receipts/rcpt-9') return send(200, RECEIPT);
    if (url.pathname === '/v1/aci/attestation') {
      assert.match(url.searchParams.get('nonce')!, /^[0-9a-f]{64}$/);
      return send(200, { api_version: 'aci/1', workload_keyset_digest: RECEIPT.workload_keyset_digest, attestation: {} });
    }
    if (url.pathname.startsWith('/receipts/')) return send(200, { status: 'pending', digest: url.pathname.split('/')[2] });
    send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const net = (): Network => ({ ...TESTNET, gateway: base, control: base, rpcUrl: `${base}/rpc` });
const signer = (): Signer => ({
  address: addressOfKey(unhex(KEY)),
  signMessage: async (m) => personalSign(m, unhex(KEY)),
  sendTransaction: async (tx) => {
    state.txs.push(tx);
    // a mined deposit is credited net of the 5% fee, as the control plane's watcher does
    const m = /^0x(b6b55f25|2f4f21e2)/.exec(tx.data);
    if (m) state.account.balanceMicros += (BigInt('0x' + tx.data.slice(-64)) * 95n) / 100n;
    return `0x${String(state.txs.length).padStart(64, '0')}`;
  },
});

test('signIn signs only envolvr\'s own message', async () => {
  state.tamper = false;
  const { apiKey } = await signIn(signer(), net());
  assert.match(apiKey, /^envk_for_/);
  state.tamper = true;
  await assert.rejects(signIn(signer(), net()), /refusing to sign/);
  state.tamper = false;
});

test('depositUsdg: approves when needed, deposits for yourself or another wallet, reports the net credit', async () => {
  state.txs = []; state.allowance = 0n;
  const r = await depositUsdg({ signer: signer(), amountMicros: 10_000_000n, network: net() });
  assert.equal(state.txs.length, 2);
  assert.equal(state.txs[0].to, TESTNET.usdg);
  assert.equal(state.txs[0].data, encodeCall('approve(address,uint256)', [TESTNET.creditVault, 10_000_000n]));
  assert.equal(state.txs[1].data, encodeCall('deposit(uint256)', [10_000_000n]));
  assert.equal(r.expectedCreditMicros, 9_500_000n);

  state.txs = []; state.allowance = 10n ** 12n;
  const other = '0x' + '77'.repeat(20);
  await depositUsdg({ signer: signer(), amountMicros: 1_000_000n, account: other, network: net() });
  assert.deepEqual(state.txs.map((t) => t.data), [encodeCall('depositFor(address,uint256)', [other, 1_000_000n])]);

  state.balance = 5n;
  await assert.rejects(depositUsdg({ signer: signer(), amountMicros: 1_000_000n, network: net() }), /less than/);
  state.balance = 50_000_000n;
});

test('chat saves the receipt, the exact bytes and the keyset\'s attestation report; verify reads them back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'envolvr-sdk-'));
  const client = new Envolvr({ apiKey: 'envk_agent', network: net(), receiptDir: dir });
  const { response, receiptId, saved } = await client.chat({ model: 'z-ai/glm-5.3', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(response.choices[0].message.content, 'sealed');
  assert.equal(receiptId, 'rcpt-9');
  for (const f of ['receipt.json', 'request.json', 'response.json']) assert.ok(existsSync(join(saved!.dir!, f)), f);
  assert.equal(JSON.parse(readFileSync(join(saved!.dir!, 'request.json'), 'utf8')).stream, false);
  const report = join(dir, 'attestation', `${RECEIPT.workload_keyset_digest.replace(':', '-')}.json`);
  assert.ok(existsSync(report) && existsSync(report.replace(/\.json$/, '.nonce')));
  assert.equal(createHash('sha256').update(readFileSync(join(saved!.dir!, 'receipt.json'))).digest('hex').length, 64);

  // The signature check needs pap; here only billing, payer and the anchor lookup are exercised.
  const v = await verifySaved(saved!.dir!, { network: net(), apiKey: 'envk_agent', receiptDir: dir, skipSignature: true });
  assert.equal(v.billing?.billedMicroUsd, 300);
  assert.equal(v.chargedToKey, true);
  assert.equal(v.anchor.status, 'pending');
});

test('closeAccount signs only the close message for the refund address it asked for', async () => {
  state.tamper = false;
  const r = await closeAccount(signer(), { network: net() });
  assert.equal(r.refund?.refundTo, addressOfKey(unhex(KEY)));
  state.tamper = true;
  await assert.rejects(closeAccount(signer(), { network: net(), refundTo: '0x' + '44'.repeat(20) }), /refusing to sign/);
  state.tamper = false;
});


// ---- automatic top-up ----

const AGENT = addressOfKey(unhex(KEY));
function fresh(balanceMicros: bigint, wallet = AGENT) {
  state.txs = []; state.allowance = 10n ** 12n; state.balance = 50_000_000n; state.need = 0n;
  state.account = { wallet: wallet.toLowerCase(), balanceMicros, reads: 0 };
}
const deposits = () => state.txs.filter((t) => /^0x(b6b55f25|2f4f21e2)/.test(t.data));
const client = (events: TopUpEvent[], over: Record<string, unknown> = {}) => new Envolvr({
  apiKey: 'envk_agent', network: net(),
  autoTopUp: { signer: signer(), below: '5', amount: '20', onEvent: (e) => events.push(e), ...over },
});

test('auto top-up: a low account is topped up before the request and credited before it runs', async () => {
  fresh(1_000_000n);
  const events: TopUpEvent[] = [];
  await client(events).chat({ model: 'm', messages: [] });
  assert.deepEqual(deposits().map((t) => t.data), [encodeCall('deposit(uint256)', [20_000_000n])]);
  assert.equal(state.account.balanceMicros, 20_000_000n);
  assert.equal(events[0].type, 'topped-up');
  assert.equal((events[0] as { creditedMicros: bigint }).creditedMicros, 19_000_000n);
});

test('auto top-up: enough credit, no deposit, and the account is read at most every checkEveryMs', async () => {
  fresh(50_000_000n);
  const c = client([], { checkEveryMs: 60_000 });
  await c.chat({ model: 'm', messages: [] });
  await c.chat({ model: 'm', messages: [] });
  assert.equal(deposits().length, 0);
  assert.equal(state.account.reads, 1);
});

test('auto top-up: concurrent requests share one top-up', async () => {
  fresh(0n);
  const c = client([], { maxPerDay: '100' });
  await Promise.all([1, 2, 3].map(() => c.chat({ model: 'm', messages: [] })));
  assert.equal(deposits().length, 1);
});

test('auto top-up: the daily cap stops further deposits and says so once', async () => {
  fresh(1_000_000n);
  const events: TopUpEvent[] = [];
  const c = client(events, { checkEveryMs: 0 });
  await c.chat({ model: 'm', messages: [] });
  state.account.balanceMicros = 1_000_000n; // spent again the same day
  await c.chat({ model: 'm', messages: [] });
  await c.chat({ model: 'm', messages: [] });
  assert.equal(deposits().length, 1);
  assert.deepEqual(events.map((e) => e.type), ['topped-up', 'capped']);
});

test('auto top-up: a 402 tops up and retries once; without auto top-up the 402 is thrown', async () => {
  fresh(50_000_000n);
  const c = client([], { checkEveryMs: 60_000 });
  await c.chat({ model: 'm', messages: [] }); // reads the account: plenty
  state.account.balanceMicros = 1_000_000n; // spent down before the next check is due
  state.need = 10_000_000n;
  const r = await c.chat({ model: 'm', messages: [] }); // 402, top-up, retry
  assert.equal(r.response.choices[0].message.content, 'sealed');
  assert.equal(deposits().length, 1);
  assert.equal(state.account.reads, 3); // the first check, the 402's read, the credit check
  fresh(0n); state.need = 1n;
  await assert.rejects(new Envolvr({ apiKey: 'envk_agent', network: net() }).chat({ model: 'm', messages: [] }), (e: any) => e.status === 402);
});

test('auto top-up: a signer that is not the account wallet deposits for it', async () => {
  const agent = '0x' + '42'.repeat(20);
  fresh(0n, agent);
  await client([]).chat({ model: 'm', messages: [] });
  assert.deepEqual(deposits().map((t) => t.data), [encodeCall('depositFor(address,uint256)', [agent, 20_000_000n])]);
});

test('auto top-up: a failed deposit is reported and the request still runs', async () => {
  fresh(1_000_000n);
  state.balance = 0n; // the paying wallet holds no USDG
  const events: TopUpEvent[] = [];
  await client(events).chat({ model: 'm', messages: [] });
  assert.equal(events[0].type, 'failed');
  assert.match((events[0] as { error: Error }).error.message, /less than/);
});

test('MAINNET: on-chain steps refuse until the contracts are published', async () => {
  assert.equal(MAINNET.chainId, 4663);
  await assert.rejects(depositUsdg({ signer: signer(), amountMicros: 1n, network: MAINNET }), /published at launch/);
});
