// Shared by the operator scripts that move USDG out of the credit vault as its owner.
//
//   CONTROL_URL (default https://auth.envolvr.xyz), ADMIN_TOKEN, OWNER_PRIVATE_KEY,
//   RPC_URL, CHAIN_ID and CREDIT_VAULT (default Robinhood Chain testnet).

import { hexToBytes } from '@noble/hashes/utils';
import { addressOfKey, encodeCall, Rpc, signTx } from '../src/evm.ts';

export const CONTROL = process.env.CONTROL_URL ?? 'https://auth.envolvr.xyz';
const ADMIN = process.env.ADMIN_TOKEN;
const RPC_URL = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com/rpc';
const CHAIN_ID = BigInt(process.env.CHAIN_ID ?? 46630);
export const VAULT = process.env.CREDIT_VAULT ?? '0x2aaB804f3eB6B436CB542d56D171d020bC2d7c51';

export const usd = (micros: bigint | string) => `$${(Number(micros) / 1e6).toFixed(6)}`;

export async function admin<T>(path: string, body?: unknown): Promise<T> {
  if (!ADMIN) throw new Error('set ADMIN_TOKEN');
  const r = await fetch(`${CONTROL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(json)}`);
  return json as T;
}

export interface Reserves {
  vaultUsdgMicros: string | null; owedMicros: string; withdrawableMicros: string | null; solvent: boolean | null;
  shortfallMicros: string; balancesMicros: string; refundsPendingMicros: string; refundsHeldMicros: string;
  depositsHeldMicros: string; overdrawnMicros: string;
}

export const reserves = () => admin<Reserves>('/admin/reserves');

export function printReserves(r: Reserves): void {
  console.log(`vault ${r.vaultUsdgMicros === null ? 'unknown' : usd(r.vaultUsdgMicros)}, owed to users ${usd(r.owedMicros)}`
    + ` (balances ${usd(r.balancesMicros)}, refunds ${usd(BigInt(r.refundsPendingMicros) + BigInt(r.refundsHeldMicros))},`
    + ` held deposits ${usd(r.depositsHeldMicros)}), withdrawable ${r.withdrawableMicros === null ? 'unknown' : usd(r.withdrawableMicros)}`
    + (r.solvent === false ? `, SHORTFALL ${usd(r.shortfallMicros)}` : ''));
}

/** The owner key, checked against CreditVault.owner(). */
export async function owner(): Promise<{ key: Uint8Array; address: string; rpc: Rpc }> {
  const keyHex = process.env.OWNER_PRIVATE_KEY;
  if (!keyHex) throw new Error('set OWNER_PRIVATE_KEY (the credit vault owner)');
  const key = hexToBytes(keyHex.replace(/^0x/, ''));
  const address = addressOfKey(key);
  const rpc = new Rpc(RPC_URL);
  const vaultOwner = `0x${(await rpc.call<string>('eth_call', [{ to: VAULT, data: encodeCall('owner()', []) }, 'latest'])).slice(-40)}`;
  if (vaultOwner.toLowerCase() !== address.toLowerCase()) throw new Error(`the key is ${address}, the vault owner is ${vaultOwner}`);
  return { key, address, rpc };
}

/** CreditVault.withdraw(to, amount) from the owner; resolves with the hash once mined, throws if it reverted. */
export async function withdraw(o: { key: Uint8Array; address: string; rpc: Rpc }, to: string, micros: bigint): Promise<string> {
  const data = encodeCall('withdraw(address,uint256)', [to, micros]);
  const [nonce, gas, block] = await Promise.all([
    o.rpc.call<string>('eth_getTransactionCount', [o.address, 'pending']),
    o.rpc.call<string>('eth_estimateGas', [{ from: o.address, to: VAULT, data }]),
    o.rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]),
  ]);
  const baseFee = BigInt(block.baseFeePerGas ?? (await o.rpc.call<string>('eth_gasPrice', [])));
  const { raw, hash } = signTx({
    chainId: CHAIN_ID, nonce: BigInt(nonce), maxPriorityFeePerGas: 0n, maxFeePerGas: baseFee * 2n,
    gas: (BigInt(gas) * 13n) / 10n, to: VAULT, value: 0n, data,
  }, o.key);
  await o.rpc.call('eth_sendRawTransaction', [raw]);
  let mined: { status: string } | null = null;
  for (let i = 0; i < 90 && !mined; i++) {
    mined = await o.rpc.call<{ status: string } | null>('eth_getTransactionReceipt', [hash]);
    if (!mined) await new Promise((res) => setTimeout(res, 2_000));
  }
  if (!mined || BigInt(mined.status) !== 1n) throw new Error(`transaction ${hash} ${mined ? 'reverted' : 'not mined'}`);
  return hash;
}
