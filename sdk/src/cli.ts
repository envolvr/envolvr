#!/usr/bin/env node
// envolvr: sign in, fund, run private inference, and verify its receipts.
//
//   ENVOLVR_PRIVATE_KEY  wallet key, for signin, deposit and testnet-mint
//   ENVOLVR_API_KEY      API key, for everything else (or ~/.envolvr/credentials.json)

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { depositUsdg, getPricing, mintTestUsdg, signIn } from './api.ts';
import { AUDIT_CHECKS, verifyGateway } from './attest.ts';
import { Envolvr, savedReceipts, verifySaved } from './client.ts';
import { fromMicros, TESTNET, toMicros } from './network.ts';
import { privateKeySigner } from './wallet.ts';

const HELP = `envolvr: private inference your agent can prove

  envolvr signin [--save]             sign in with ENVOLVR_PRIVATE_KEY, print a new API key
  envolvr testnet-mint <usd>          mint test USDG to the wallet (testnet)
  envolvr deposit <usd> [--for 0x…]   deposit USDG (net of the deposit fee) to your balance
  envolvr account                     balance and today's staking allowance
  envolvr pricing                     the deposit fee and how token prices are set
  envolvr models                      models and per-token prices
  envolvr chat <prompt> [--model m] [--provider '{"only":["near-ai"]}']
                                      one request; prints the reply and saves its receipt
  envolvr verify [<receipt dir>|--last] [--accept-compose <hash>]
                                      signature, billing, payer and on-chain anchor of a receipt
  envolvr verify-gateway [--accept-compose <hash>]
                                      attestation of the live gateway (TDX quote, source, TLS key)

Receipts are saved under ./envolvr-receipts (ENVOLVR_RECEIPTS to change).`;

const args = process.argv.slice(2);
const [command] = args;
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i > 0 ? args[i + 1] : undefined;
};
const network = TESTNET;
const receiptDir = process.env.ENVOLVR_RECEIPTS ?? 'envolvr-receipts';
const credentialsPath = join(homedir(), '.envolvr', 'credentials.json');

function wallet() {
  const key = process.env.ENVOLVR_PRIVATE_KEY;
  if (!key) throw new Error('set ENVOLVR_PRIVATE_KEY to the wallet key');
  return privateKeySigner(key, { rpcUrl: network.rpcUrl, chainId: network.chainId });
}

function apiKey(): string {
  if (process.env.ENVOLVR_API_KEY) return process.env.ENVOLVR_API_KEY;
  if (existsSync(credentialsPath)) return (JSON.parse(readFileSync(credentialsPath, 'utf8')) as { apiKey: string }).apiKey;
  throw new Error('set ENVOLVR_API_KEY, or run envolvr signin --save');
}

const usd = (micros: bigint | string) => `$${fromMicros(micros)}`;
const check = (ok: boolean | undefined) => (ok ? '✓' : ok === false ? '✗' : '·');

async function main() {
  switch (command) {
    case 'signin': {
      const { apiKey: key, wallet: w } = await signIn(wallet(), network);
      if (args.includes('--save')) {
        mkdirSync(join(homedir(), '.envolvr'), { recursive: true });
        writeFileSync(credentialsPath, JSON.stringify({ apiKey: key, wallet: w }));
        chmodSync(credentialsPath, 0o600);
        console.log(`signed in as ${w}; API key saved to ${credentialsPath}`);
      } else {
        console.log(`signed in as ${w}\nAPI key (shown once): ${key}`);
      }
      return;
    }
    case 'testnet-mint': {
      const tx = await mintTestUsdg({ signer: wallet(), amountMicros: toMicros(args[1]), network });
      console.log(`minted ${args[1]} test USDG: ${network.explorer}/tx/${tx}`);
      return;
    }
    case 'deposit': {
      const r = await depositUsdg({ signer: wallet(), amountMicros: toMicros(args[1]), account: flag('for'), network });
      console.log(`deposited ${usd(r.amountMicros)} for ${r.account}: ${network.explorer}/tx/${r.depositTx}`);
      console.log(`credit ${usd(r.expectedCreditMicros)} after the ${r.depositFeeBps / 100}% deposit fee, within seconds`);
      return;
    }
    case 'account': {
      const a = await new Envolvr({ apiKey: apiKey(), network }).account();
      console.log(`${a.wallet}\nbalance ${usd(a.balanceMicros)} | allowance today ${usd(a.allowanceTodayMicros)}, left ${usd(a.allowanceLeftMicros)}`);
      return;
    }
    case 'pricing': {
      const p = await getPricing(network);
      console.log(`tokens: ${p.tokenPricing}\ndeposit fee: ${p.depositFeeBps / 100}%`);
      return;
    }
    case 'models':
      console.log(JSON.stringify(await new Envolvr({ apiKey: apiKey(), network }).models(), null, 2));
      return;
    case 'chat': {
      const client = new Envolvr({ apiKey: apiKey(), network, receiptDir });
      const provider = flag('provider');
      const { response, saved } = await client.chat({
        model: flag('model') ?? 'z-ai/glm-5.3',
        messages: [{ role: 'user', content: args[1] }],
        ...(provider ? { provider: JSON.parse(provider) } : {}),
      });
      console.log(response.choices?.[0]?.message?.content ?? JSON.stringify(response));
      console.log(`\ncost $${response.usage?.cost ?? '?'} | receipt ${saved?.id ?? 'none'}${saved?.dir ? ` saved to ${saved.dir}` : ''}`);
      return;
    }
    case 'verify': {
      const dir = args[1] && !args[1].startsWith('--') ? args[1] : savedReceipts(receiptDir).at(-1);
      if (!dir) throw new Error(`no saved receipt in ${receiptDir}`);
      const key = process.env.ENVOLVR_API_KEY ?? (existsSync(credentialsPath) ? apiKey() : undefined);
      const acceptCompose = flag('accept-compose') ? [flag('accept-compose')!] : undefined;
      const v = await verifySaved(dir, { network, apiKey: key, receiptDir, acceptCompose });
      console.log(`receipt ${v.receiptId}`);
      if (v.audit) {
        for (const [id, label] of Object.entries(AUDIT_CHECKS)) {
          const c = v.audit.checks[id];
          console.log(`${c?.status === 'pass' ? '✓' : c?.status === 'fail' ? '✗' : '·'} ${label}`);
        }
        for (const c of v.audit.failed.filter((f) => !(f.id in AUDIT_CHECKS))) console.log(`✗ ${c.title}: ${c.detail}`);
      } else {
        console.log(`${check(false)} signature                   ${String(v.signature.transcript)}`);
      }
      if (v.billing) {
        console.log(`${check(true)} billing                     ${v.billing.cost} ${v.billing.currency} for ${v.billing.tokens.prompt}+${v.billing.tokens.completion} tokens, billed ${usd(BigInt(v.billing.billedMicroUsd))}`);
        console.log(`${check(v.chargedToKey)} charged to this key         ${v.chargedToKey === undefined ? 'no API key given' : v.chargedToKey ? 'yes' : 'no'}`);
      } else {
        console.log(`${check(undefined)} billing                     not priced (no billing event)`);
      }
      const a = v.anchor;
      console.log(`${check(a.status === 'anchored')} anchor                      ${a.status === 'anchored'
        ? `batch ${a.batchIndex}, leaf ${a.leafIndex} of ${a.count}, ${new Date(a.anchoredAt! * 1000).toISOString()}, tx ${a.txHash}`
        : a.status === 'pending' ? 'pending: batches close every 10 minutes (UTC)' : 'unknown to the proof service'}`);
      const signed = v.audit?.signed ?? false;
      const ok = signed && a.status === 'anchored';
      console.log(`\nverdict: ${ok ? 'VERIFIED' : signed && a.status === 'pending' ? 'SIGNED, ANCHOR PENDING' : 'NOT VERIFIED'}`);
      if (!signed && v.audit) console.log('pap transcript:', JSON.stringify(v.signature.transcript, null, 2).slice(0, 4000));
      process.exit(ok ? 0 : signed && a.status === 'pending' ? 2 : 1);
    }
    case 'verify-gateway': {
      const r = await verifyGateway(network, { acceptCompose: flag('accept-compose') ? [flag('accept-compose')!] : undefined });
      console.log(typeof r.transcript === 'string' ? r.transcript : JSON.stringify(r.transcript, null, 2));
      process.exit(r.verified ? 0 : 1);
    }
    default:
      console.log(HELP);
      process.exit(command && command !== 'help' && command !== '--help' ? 2 : 0);
  }
}

main().catch((err) => {
  const message = (err as Error).message;
  console.error(message === 'fetch failed'
    ? `error: could not reach envolvr (${network.gateway}, ${network.control}); try again shortly`
    : `error: ${message}`);
  process.exit(1);
});
