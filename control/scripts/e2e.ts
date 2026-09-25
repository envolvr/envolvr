// End-to-end client: wallet sign-in -> credit -> request through the gateway
// (middleware -> control plane -> upstream) -> receipt -> bill.
// Local by default; set CONTROL_URL and GATEWAY_URL for a deployment.
// ADMIN_TOKEN is the control plane admin token. MODEL picks the model and
// PROVIDER (JSON, e.g. '{"only":["near-ai"]}') the caller's routing block.
// ANCHOR_WAIT (seconds) also waits for the receipt's anchoring proof.
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressOf, personalSign } from '../src/auth.ts';
import { verifyProof } from '../src/merkle.ts';

const CONTROL = process.env.CONTROL_URL ?? 'http://127.0.0.1:8787';
const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8086';
const MODEL = process.env.MODEL ?? 'z-ai/glm-5.3';
const PROVIDER = process.env.PROVIDER ? JSON.parse(process.env.PROVIDER) : undefined;
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
  body: JSON.stringify({ model: MODEL, max_tokens: 300, provider: PROVIDER, messages: [{ role: 'user', content: 'Reply with the single word: sealed' }] }) });

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

const receiptRes = await fetch(`${GATEWAY}/v1/aci/receipts/${receiptId}`, { headers: { authorization: `Bearer ${apiKey}` } });
const receiptBytes = Buffer.from(await receiptRes.arrayBuffer());
const receipt = { status: receiptRes.status, body: JSON.parse(receiptBytes.toString('utf8') || 'null') as any };
const log = receipt.body?.event_log ?? [];
const events = log.map((e: any) => e.type);
console.log('6. receipt fetch:', receipt.status, '| events:', JSON.stringify(events));
const selected = log.find((e: any) => e.type === 'route.selected');
const attested = log.find((e: any) => e.type === 'upstream.response_attested');
console.log('   route:', selected?.route_id ?? selected?.selected_route ?? JSON.stringify(selected ?? null),
  '| enclave binding:', attested ? `bound=${attested.bound} signer=${attested.signing_address ?? '-'} ${attested.reason ?? ''}` : 'none');

await new Promise((r) => setTimeout(r, 1500)); // post-consult is fire-and-forget
const acct = await json(await fetch(`${CONTROL}/admin/account?wallet=${wallet}`, { headers: admin }));
console.log('7. bill: balance', acct.body.balanceMicros, 'micro-USD (from 500000) | allowance today', acct.body.allowanceTodayMicros);

if (process.env.ANCHOR_WAIT) {
  // The digest a verifier computes: SHA-256 of the receipt's JCS bytes, which is what the gateway serves.
  const digest = `0x${createHash('sha256').update(receiptBytes).digest('hex')}`;
  const deadline = Date.now() + Number(process.env.ANCHOR_WAIT) * 1000;
  let proof: any;
  do {
    proof = (await json(await fetch(`${CONTROL}/receipts/${digest}/proof`))).body;
    if (proof?.status === 'anchored') break;
    await new Promise((r) => setTimeout(r, 5000));
  } while (Date.now() < deadline);
  console.log('8. anchoring:', digest, '|', proof?.status ?? JSON.stringify(proof),
    ...(proof?.status === 'anchored'
      ? ['| batch', proof.batchIndex, 'leaf', proof.leafIndex, 'of', proof.count, '| tx', proof.txHash,
        '| proof verifies against root:', verifyProof(proof.root, digest, proof.proof)]
      : []));
}
