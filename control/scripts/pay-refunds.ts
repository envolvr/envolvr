// Pay the refunds of closed accounts from the credit vault, as its owner.
//
//   CONTROL_URL=https://auth.envolvr.xyz ADMIN_TOKEN=… OWNER_PRIVATE_KEY=… \
//     node --disable-warning=ExperimentalWarning scripts/pay-refunds.ts [--send]
//
// Lists pending refunds and, with --send, pays each one with
// CreditVault.withdraw(refundTo, amount) from the owner key, waits for it to be
// mined, and records it as paid. Without --send it only prints what it would
// pay. RPC_URL, CHAIN_ID and CREDIT_VAULT default to Robinhood Chain testnet.
// Held refunds (flagged by sanctions screening) are never paid here.

import { hexToBytes } from '@noble/hashes/utils';
import { addressOfKey, encodeCall, Rpc, signTx } from '../src/evm.ts';

const CONTROL = process.env.CONTROL_URL ?? 'https://auth.envolvr.xyz';
const ADMIN = process.env.ADMIN_TOKEN;
const RPC_URL = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com/rpc';
const CHAIN_ID = BigInt(process.env.CHAIN_ID ?? 46630);
const VAULT = process.env.CREDIT_VAULT ?? '0x2aaB804f3eB6B436CB542d56D171d020bC2d7c51';
const send = process.argv.includes('--send');
if (!ADMIN) throw new Error('set ADMIN_TOKEN');

const admin = (path: string, body?: unknown) => fetch(`${CONTROL}${path}`, {
  method: body ? 'POST' : 'GET',
  headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => {
  const json = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(json)}`);
  return json;
});

const { refunds } = await admin('/admin/refunds?status=pending') as {
  refunds: { id: number; refundTo: string; amountMicros: string }[];
};
const usd = (m: string) => `$${(Number(m) / 1e6).toFixed(6)}`;
console.log(`${refunds.length} pending refund(s), ${usd(String(refunds.reduce((a, r) => a + BigInt(r.amountMicros), 0n)))} in total`);
for (const r of refunds) console.log(`  #${r.id} ${usd(r.amountMicros)} -> ${r.refundTo}`);
if (!send || refunds.length === 0) {
  if (!send && refunds.length) console.log('dry run: add --send to pay them');
  process.exit(0);
}

const keyHex = process.env.OWNER_PRIVATE_KEY;
if (!keyHex) throw new Error('set OWNER_PRIVATE_KEY (the credit vault owner)');
const key = hexToBytes(keyHex.replace(/^0x/, ''));
const owner = addressOfKey(key);
const rpc = new Rpc(RPC_URL);
const vaultOwner = `0x${(await rpc.call<string>('eth_call', [{ to: VAULT, data: encodeCall('owner()', []) }, 'latest'])).slice(-40)}`;
if (vaultOwner.toLowerCase() !== owner.toLowerCase()) throw new Error(`the key is ${owner}, the vault owner is ${vaultOwner}`);

for (const r of refunds) {
  const data = encodeCall('withdraw(address,uint256)', [r.refundTo, BigInt(r.amountMicros)]);
  const [nonce, gas, block] = await Promise.all([
    rpc.call<string>('eth_getTransactionCount', [owner, 'pending']),
    rpc.call<string>('eth_estimateGas', [{ from: owner, to: VAULT, data }]),
    rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]),
  ]);
  const baseFee = BigInt(block.baseFeePerGas ?? (await rpc.call<string>('eth_gasPrice', [])));
  const { raw, hash } = signTx({
    chainId: CHAIN_ID, nonce: BigInt(nonce), maxPriorityFeePerGas: 0n, maxFeePerGas: baseFee * 2n,
    gas: (BigInt(gas) * 13n) / 10n, to: VAULT, value: 0n, data,
  }, key);
  await rpc.call('eth_sendRawTransaction', [raw]);
  let mined: { status: string } | null = null;
  for (let i = 0; i < 90 && !mined; i++) {
    mined = await rpc.call<{ status: string } | null>('eth_getTransactionReceipt', [hash]);
    if (!mined) await new Promise((res) => setTimeout(res, 2_000));
  }
  if (!mined || BigInt(mined.status) !== 1n) throw new Error(`refund #${r.id}: transaction ${hash} ${mined ? 'reverted' : 'not mined'}`);
  await admin('/admin/refunds/paid', { id: r.id, txHash: hash });
  console.log(`paid #${r.id} ${usd(r.amountMicros)} -> ${r.refundTo}: ${hash}`);
}
