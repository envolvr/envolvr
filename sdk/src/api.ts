// envolvr's HTTP surface for an agent: sign in with a wallet, read the account
// and the pricing, and move USDG into the credit vault.

import { decodeWords, encodeCall, Rpc } from './evm.ts';
import { type Network, TESTNET } from './network.ts';
import type { Signer } from './wallet.ts';

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${new URL(res.url).pathname}: ${res.status} ${body.error ?? ''}`.trim());
  return body;
}

/** The message the sign-in signs; the SDK signs nothing else. */
export function signInMessage(wallet: string, nonce: string, issuedAt: string): string {
  return ['envolvr: sign in to get an API key.', '', `Wallet: ${wallet.toLowerCase()}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`]
    .join('\n');
}

/**
 * Sign in with a wallet and get an API key. The key is shown once; keep it.
 * Each sign-in issues a new key; earlier keys keep working.
 */
export async function signIn(signer: Signer, network: Network = TESTNET): Promise<{ apiKey: string; wallet: string }> {
  const n = await json<{ nonce: string; issuedAt: string; message: string }>(
    await fetch(`${network.control}/auth/nonce?wallet=${signer.address}`),
  );
  const expected = signInMessage(signer.address, n.nonce, n.issuedAt);
  if (n.message !== expected) throw new Error('the sign-in message is not the one envolvr defines; refusing to sign it');
  const signature = await signer.signMessage(expected);
  return json(await fetch(`${network.control}/auth/key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: signer.address, nonce: n.nonce, issuedAt: n.issuedAt, signature }),
  }));
}

export interface Account {
  wallet: string;
  /** USDG balance, micro-USD (6 decimals), as a decimal string. */
  balanceMicros: string;
  /** Today's staking allowance and what is left of it, micro-USD. */
  allowanceTodayMicros: string;
  allowanceLeftMicros: string;
}

export async function getAccount(apiKey: string, network: Network = TESTNET): Promise<Account> {
  return json(await fetch(`${network.control}/account`, { headers: { authorization: `Bearer ${apiKey}` } }));
}

export interface Pricing {
  /** Kept from each USDG deposit, in basis points (500 = 5%). */
  depositFeeBps: number;
  tokenPricing: string;
}

export async function getPricing(network: Network = TESTNET): Promise<Pricing> {
  return json(await fetch(`${network.control}/pricing`));
}

/** What a deposit of `amountMicros` credits at `feeBps` (the fee rounds down). */
export function netCredit(amountMicros: bigint, feeBps: number): bigint {
  return amountMicros - (amountMicros * BigInt(feeBps)) / 10_000n;
}

/**
 * Deposit USDG into the credit vault for `account` (default: the signer's own
 * wallet, the one that signs in). Approves the vault first when needed. The
 * balance is credited, net of the deposit fee, within seconds of the deposit
 * being mined. Deposit from a wallet you control; a plain USDG transfer to the
 * vault is not credited.
 */
export async function depositUsdg(opts: { signer: Signer; amountMicros: bigint; account?: string; network?: Network }) {
  const network = opts.network ?? TESTNET;
  const { signer, amountMicros } = opts;
  if (!signer.sendTransaction) throw new Error('this signer cannot send transactions');
  if (amountMicros <= 0n) throw new Error('the amount must be positive');
  const rpc = new Rpc(network.rpcUrl);
  const view = async (to: string, sig: string, args: (bigint | string)[]) =>
    BigInt(decodeWords(await rpc.call<string>('eth_call', [{ to, data: encodeCall(sig, args) }, 'latest']))[0]);
  const balance = await view(network.usdg, 'balanceOf(address)', [signer.address]);
  if (balance < amountMicros) throw new Error(`the wallet holds ${balance} micro-USDG, less than ${amountMicros}`);
  const { depositFeeBps } = await getPricing(network);

  let approveTx: string | undefined;
  if ((await view(network.usdg, 'allowance(address,address)', [signer.address, network.creditVault])) < amountMicros) {
    approveTx = await signer.sendTransaction({
      to: network.usdg, data: encodeCall('approve(address,uint256)', [network.creditVault, amountMicros]),
    });
  }
  const account = opts.account ?? signer.address;
  const depositTx = await signer.sendTransaction({
    to: network.creditVault,
    data: account.toLowerCase() === signer.address.toLowerCase()
      ? encodeCall('deposit(uint256)', [amountMicros])
      : encodeCall('depositFor(address,uint256)', [account, amountMicros]),
  });
  return { approveTx, depositTx, account, amountMicros, depositFeeBps, expectedCreditMicros: netCredit(amountMicros, depositFeeBps) };
}

/** Testnet only: mint test USDG to the signer (the test token has an open mint). */
export async function mintTestUsdg(opts: { signer: Signer; amountMicros: bigint; network?: Network }): Promise<string> {
  const network = opts.network ?? TESTNET;
  if (network.chainId !== TESTNET.chainId) throw new Error('mintTestUsdg is for the testnet only');
  if (!opts.signer.sendTransaction) throw new Error('this signer cannot send transactions');
  return opts.signer.sendTransaction({
    to: network.usdg, data: encodeCall('mint(address,uint256)', [opts.signer.address, opts.amountMicros]),
  });
}
