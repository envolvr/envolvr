import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressOf, hashApiKey, personalSign } from '../src/auth.ts';
import type { Config } from '../src/config.ts';
import { Store, type DepositEvent } from '../src/db.ts';
import { DepositWatcher, type LogSource } from '../src/deposits.ts';
import { encodeCall } from '../src/evm.ts';
import { CHAINALYSIS_ORACLE, OracleSource, Screening, ScreeningUnavailable, type SanctionsSource } from '../src/screening.ts';
import { createControlServer } from '../src/server.ts';

const BAD = '0x098b716b8aaf21512996dc57eb0615e2383e2f96'; // Lazarus Group (OFAC SDN), flagged by the live oracle
const GOOD = '0x' + '11'.repeat(20);

// --- The oracle source, against a JSON-RPC stub ---

let rpc: Server;
let rpcUrl: string;
const rpcCalls: unknown[] = [];

before(async () => {
  rpc = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const call = JSON.parse(Buffer.concat(chunks).toString());
    rpcCalls.push(call.params[0]);
    const flagged = call.params[0].data.endsWith(BAD.slice(2));
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: `0x${(flagged ? 1n : 0n).toString(16).padStart(64, '0')}` }));
  });
  await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', r));
  rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}/`;
});
after(() => rpc.close());

test('OracleSource calls isSanctioned(address) on the Chainalysis oracle', async () => {
  const source = new OracleSource(rpcUrl);
  assert.equal(await source.isSanctioned(BAD), true);
  assert.equal(await source.isSanctioned(GOOD), false);
  assert.deepEqual(rpcCalls[0], { to: CHAINALYSIS_ORACLE, data: encodeCall('isSanctioned(address)', [BAD]) });
  assert.equal(encodeCall('isSanctioned(address)', [BAD]).slice(0, 10), '0xdf592f7d');
});

// --- Screening rules ---

function fake(name: string, answer: (w: string) => boolean | Error): SanctionsSource & { calls: number } {
  const s = {
    name, calls: 0,
    isSanctioned: async (w: string) => {
      s.calls++;
      const a = answer(w);
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return s;
}

test('any source saying sanctioned counts; a lookup fails only when every source fails', async () => {
  const store = new Store(':memory:');
  const down = fake('down', () => new Error('timeout'));
  const lists = fake('lists', (w) => w === BAD);
  const s = new Screening(store, { sources: [fake('clean', () => false), lists, down] });
  assert.equal(await s.check(BAD), true);
  assert.equal(await s.check(GOOD), false);
  const allDown = new Screening(new Store(':memory:'), { sources: [down, fake('down2', () => new Error('503'))] });
  await assert.rejects(allDown.check(GOOD), ScreeningUnavailable);
});

test('results are kept, rescreened after the window, and the static blocklist applies', async () => {
  const store = new Store(':memory:');
  let t = 1_000;
  let listed = false;
  const src = fake('src', () => listed);
  const s = new Screening(store, { sources: [src], rescreenAfterSeconds: 100, now: () => t, blocklist: [GOOD.toUpperCase().replace('0X', '0x')] });
  assert.equal(await s.check(GOOD), true, 'static blocklist, case-insensitive');
  assert.equal(src.calls, 0);
  const w = '0x' + '22'.repeat(20);
  assert.equal(await s.check(w), false);
  listed = true;
  t += 50;
  assert.equal(await s.check(w), false, 'within the window: the stored result');
  assert.equal(src.calls, 1);
  t += 60;
  assert.equal(await s.check(w), true, 'past the window: looked up again');
  assert.equal(src.calls, 2);
});

test('blocked(): a stale result answers at once and refreshes in the background', async () => {
  const store = new Store(':memory:');
  let t = 1_000;
  let listed = false;
  const src = fake('src', () => listed);
  const s = new Screening(store, { sources: [src], rescreenAfterSeconds: 100, now: () => t });
  const w = '0x' + '33'.repeat(20);
  assert.equal(await s.blocked(w), false, 'never screened: looked up now');
  listed = true;
  t += 500;
  assert.equal(await s.blocked(w), false, 'stale: last result, no waiting');
  await new Promise((r) => setImmediate(r));
  assert.equal(await s.blocked(w), true, 'refreshed in the background');
  assert.equal(src.calls, 2);
});

// --- Deposits ---

const ev = (block: number, account: string, payer: string, amount: bigint): DepositEvent => ({
  txHash: `0x${block.toString(16).padStart(64, '0')}`, logIndex: 0, blockNumber: block, account, payer, amountMicros: amount, depositId: block,
});
const logs = (events: DepositEvent[]): LogSource => ({
  latestBlock: async () => 200,
  depositLogs: async (from, to) => events.filter((e) => e.blockNumber >= from && e.blockNumber <= to),
});

test('deposits from or to a sanctioned wallet are held, not credited, and can be released', async () => {
  const store = new Store(':memory:');
  const s = new Screening(store, { sources: [fake('src', (w) => w === BAD)] });
  const clean = '0x' + '44'.repeat(20);
  const watcher = new DepositWatcher(store, logs([
    ev(101, clean, GOOD, 1_000_000n), ev(102, clean, BAD, 2_000_000n), ev(103, BAD, GOOD, 3_000_000n),
  ]), { startBlock: 100, confirmations: 0, screen: (w) => s.check(w) });
  const r = await watcher.pollOnce();
  assert.equal(r.credited, 1);
  assert.deepEqual(r.held, [102, 103]);
  assert.equal(store.accountByWallet(clean)?.balanceMicros, 1_000_000n);
  assert.equal(store.accountByWallet(BAD)?.balanceMicros, 0n);
  assert.deepEqual(store.heldDeposits().map((d) => [d.depositId, d.amountMicros]), [[102, 2_000_000n], [103, 3_000_000n]]);

  assert.equal(store.releaseDeposit(ev(102, clean, BAD, 0n).txHash, 0), 2_000_000n);
  assert.equal(store.releaseDeposit(ev(102, clean, BAD, 0n).txHash, 0), undefined, 'only once');
  assert.equal(store.accountByWallet(clean)?.balanceMicros, 3_000_000n);
  assert.equal(store.heldDeposits().length, 1);
});

test('a range whose screening fails is not applied, and is retried', async () => {
  const store = new Store(':memory:');
  let up = false;
  const s = new Screening(store, { sources: [fake('src', () => (up ? false : new Error('down')))] });
  const watcher = new DepositWatcher(store, logs([ev(101, GOOD, GOOD, 1_000_000n)]),
    { startBlock: 100, confirmations: 0, screen: (w) => s.check(w) });
  await assert.rejects(watcher.pollOnce(), ScreeningUnavailable);
  assert.equal(store.cursor('credit-vault'), undefined);
  assert.equal(store.accountByWallet(GOOD), undefined);
  up = true;
  assert.equal((await watcher.pollOnce()).credited, 1);
});

test('a ledger from before the held column gains it', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const path = join(mkdtempSync(join(tmpdir(), 'envolvr-migrate-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE deposits (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, account_id INTEGER NOT NULL,
    payer TEXT NOT NULL, amount_micros INTEGER NOT NULL, deposit_id INTEGER NOT NULL, block_number INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index))`);
  old.close();
  const store = new Store(path);
  assert.ok((store.db.prepare('PRAGMA table_info(deposits)').all() as { name: string }[]).some((c) => c.name === 'held'));
  store.close();
  new Store(path).close(); // and opening again is a no-op
});

// --- Sign-in and consult through the server ---

const CONTROL = 'c'.repeat(40);
const ADMIN = 'a'.repeat(40);
const config: Config = {
  port: 0, dbPath: ':memory:', marginBps: 2000, minAvailableMicros: 1000, blockedWallets: [], controlToken: CONTROL, adminToken: ADMIN,
  models: { 'z-ai/glm-5.3': { routes: [{ upstream: 'redpill', inputCostPerToken: '0.0000014', outputCostPerToken: '0.0000044' }] } },
};

async function withServer(sources: SanctionsSource[], fn: (base: string, store: Store) => Promise<void>) {
  const store = new Store(':memory:');
  const screening = new Screening(store, { sources });
  const server = createControlServer({ config, store, screening, allowance: { allowanceMicros: async () => 0n } });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, store);
  } finally {
    server.close();
  }
}

async function signIn(base: string, key: Uint8Array) {
  const wallet = addressOf(secp256k1.getPublicKey(key));
  const n = await (await fetch(`${base}/auth/nonce?wallet=${wallet}`)).json() as { nonce: string; issuedAt: string; message: string };
  const body = JSON.stringify({ wallet, nonce: n.nonce, issuedAt: n.issuedAt, signature: personalSign(n.message, key) });
  const post = () => fetch(`${base}/auth/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  return { wallet, post };
}

test('sign-in: refused for a sanctioned wallet, 503 while screening is down, and the nonce survives a 503', async () => {
  const key = secp256k1.utils.randomPrivateKey();
  const wallet = addressOf(secp256k1.getPublicKey(key));
  let down = true;
  await withServer([fake('src', (w) => (down ? new Error('down') : w === wallet))], async (base) => {
    const attempt = await signIn(base, key);
    assert.equal((await attempt.post()).status, 503);
    down = false;
    const refused = await attempt.post();
    assert.equal(refused.status, 403, 'same nonce, now screened: refused');
    assert.deepEqual(await refused.json(), { error: 'account not permitted' });
  });
  const clean = secp256k1.utils.randomPrivateKey();
  await withServer([fake('src', () => false)], async (base) => {
    const res = await (await signIn(base, clean)).post();
    assert.equal(res.status, 200);
  });
});

test('consult: a wallet screened sanctioned after sign-in is denied', async () => {
  let listed = false;
  await withServer([fake('src', () => listed)], async (base, store) => {
    const key = secp256k1.utils.randomPrivateKey();
    const res = await (await signIn(base, key)).post();
    const { apiKey, wallet } = await res.json() as { apiKey: string; wallet: string };
    store.credit(store.accountByWallet(wallet)!.id, 1_000_000n);
    const consult = async () => (await (await fetch(`${base}/consult/pre`, {
      method: 'POST', headers: { authorization: `Bearer ${CONTROL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ apiKeyHash: hashApiKey(apiKey), model: 'z-ai/glm-5.3' }),
    })).json()) as { allow: boolean; status?: number };
    assert.equal((await consult()).allow, true);
    listed = true;
    store.recordScreening(wallet, true, Math.floor(Date.now() / 1000)); // as a rescreen would record it
    assert.deepEqual(await consult(), { allow: false, status: 403, message: 'account not permitted' });
  });
});

test('admin: list and release held deposits', async () => {
  await withServer([], async (base, store) => {
    store.applyDeposits('v', [ev(150, GOOD, BAD, 5_000_000n)], 150, 1, () => true);
    const admin = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/admin/deposits/held`)).status, 401);
    const held = await (await fetch(`${base}/admin/deposits/held`, { headers: admin })).json() as { deposits: { txHash: string }[] };
    assert.equal(held.deposits.length, 1);
    const release = (logIndex: number) => fetch(`${base}/admin/deposits/release`, {
      method: 'POST', headers: admin, body: JSON.stringify({ txHash: held.deposits[0].txHash, logIndex }),
    });
    assert.equal((await release(1)).status, 404);
    assert.deepEqual(await (await release(0)).json(), { released: true, amountMicros: '5000000' });
    assert.equal(store.accountByWallet(GOOD)?.balanceMicros, 5_000_000n);
  });
});
