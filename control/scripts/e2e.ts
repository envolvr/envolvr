// End-to-end client: wallet sign-in -> credit -> request through the gateway
// (middleware -> control plane -> RedPill) -> receipt -> bill.
// Local by default; set CONTROL_URL and GATEWAY_URL for a deployment.
// ADMIN_TOKEN is the control plane admin token.
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressOf, personalSign } from '../src/auth.ts';

const CONTROL = process.env.CONTROL_URL ?? 'http://127.0.0.1:8787';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8086';
const admin = { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'content-type': 'application/json' };
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) as any });

const key = secp256k1.utils.randomPrivateKey();
const wallet = addressOf(secp256k1.getPublicKey(key));
const n = (await json(await fetch(`${CONTROL}/auth/nonce?wallet=${wallet}`))).body;
const signed = await json(await fetch(`${CONTROL}/auth/key`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ wallet, nonce: n.nonce, issuedAt: n.issuedAt, signature: personalSign(n.message, key) }) }));
const apiKey: string = signed.body.apiKey;
console.log('1. signed in', wallet, '-> key', apiKey.slice(0, 10) + '…');

const chat = (k: string) => fetch(`${GATEWAY}/v1/chat/completions`, { method: 'POST',
  headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'z-ai/glm-5.3', max_tokens: 300, messages: [{ role: 'user', content: 'Reply with the single word: sealed' }] }) });

const noCredit = await json(await chat(apiKey));
console.log('2. before credit:', noCredit.status, noCredit.body?.error?.message ?? noCredit.body);
const badKey = await json(await chat('envk_not-a-real-key'));
console.log('3. unknown key:  ', badKey.status, badKey.body?.error?.message ?? badKey.body);

await fetch(`${CONTROL}/admin/credit`, { method: 'POST', headers: admin, body: JSON.stringify({ wallet, amountMicros: '500000' }) });
console.log('4. credited $0.50');

const res = await chat(apiKey);
const receiptId = res.headers.get('x-receipt-id');
const body = await res.json() as any;
console.log('5. request:', res.status, '| reply:', JSON.stringify(body.choices?.[0]?.message?.content ?? body.error),
  '| usage:', JSON.stringify(body.usage && { prompt: body.usage.prompt_tokens, completion: body.usage.completion_tokens, cost: body.usage.cost }),
  '| receipt:', receiptId);

const receipt = await json(await fetch(`${GATEWAY}/v1/aci/receipts/${receiptId}`, { headers: { authorization: `Bearer ${apiKey}` } }));
const events = (receipt.body?.event_log ?? []).map((e: any) => e.type);
console.log('6. receipt fetch:', receipt.status, '| events:', JSON.stringify(events));

await new Promise((r) => setTimeout(r, 1500)); // post-consult is fire-and-forget
const acct = await json(await fetch(`${CONTROL}/admin/account?wallet=${wallet}`, { headers: admin }));
console.log('7. bill: balance', acct.body.balanceMicros, 'micro-USD (from 500000) | allowance today', acct.body.allowanceTodayMicros);
