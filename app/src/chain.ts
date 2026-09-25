// Robinhood Chain: balances and staking state (read over the public RPC), and
// the transactions the wallet signs (approve, deposit, stake, unstake, withdraw,
// and on testnet a test USDG mint).

import { createPublicClient, createWalletClient, custom, http, parseAbi, type Address } from 'viem';
import { chain, contracts } from './config.ts';
import type { Eip1193 } from './wallet.ts';

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
]);
const vault = parseAbi(['function deposit(uint256 amount)', 'function depositFor(address account, uint256 amount)']);
const staking = parseAbi([
  'function stake(uint256 amount)',
  'function requestUnstake(uint256 amount)',
  'function withdraw()',
  'function stakeOf(address) view returns (uint256)',
  'function totalStake() view returns (uint256)',
  'function pendingUnstake(address) view returns (uint208 amount, uint48 unlocksAt)',
  'function currentDayStart() view returns (uint256)',
  'function budgetAt(uint256) view returns (uint256)',
  'function allowanceOf(address, uint256) view returns (uint256)',
  'function cooldown() view returns (uint256)',
]);

// The public RPC answers in about a second per round trip, so the reads go out
// as one JSON-RPC batch and receipts are polled every second.
export const publicClient = createPublicClient({ chain, transport: http(undefined, { batch: true }), pollingInterval: 1_000 });

export interface ChainState {
  usdg: bigint;
  envolvr: bigint;
  staked: bigint;
  totalStake: bigint;
  pending: { amount: bigint; unlocksAt: number };
  budgetToday: bigint;
  allowanceToday: bigint;
  cooldown: number;
  eth: bigint;
}

export async function readState(address: Address): Promise<ChainState> {
  const read = <T>(address_: Address, abi: any, functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address: address_, abi, functionName, args }) as Promise<T>;
  const day = await read<bigint>(contracts.staking, staking, 'currentDayStart');
  const [usdg, envolvr, staked, totalStake, pending, budgetToday, allowanceToday, cooldown, eth] = await Promise.all([
    read<bigint>(contracts.usdg, erc20, 'balanceOf', [address]),
    read<bigint>(contracts.envolvr, erc20, 'balanceOf', [address]),
    read<bigint>(contracts.staking, staking, 'stakeOf', [address]),
    read<bigint>(contracts.staking, staking, 'totalStake'),
    read<readonly [bigint, number]>(contracts.staking, staking, 'pendingUnstake', [address]),
    read<bigint>(contracts.staking, staking, 'budgetAt', [day]),
    read<bigint>(contracts.staking, staking, 'allowanceOf', [address, day]),
    read<bigint>(contracts.staking, staking, 'cooldown'),
    publicClient.getBalance({ address }),
  ]);
  return {
    usdg, envolvr, staked, totalStake, pending: { amount: pending[0], unlocksAt: Number(pending[1]) }, budgetToday, allowanceToday,
    cooldown: Number(cooldown), eth,
  };
}

/** Send a contract call from the connected wallet and wait until it is mined. */
async function send(provider: Eip1193, account: Address, address: Address, abi: any, functionName: string, args: unknown[] = []) {
  const wallet = createWalletClient({ account, chain, transport: custom(provider) });
  const hash = await wallet.writeContract({ address, abi, functionName, args, chain, account });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  return hash;
}

async function approveIfNeeded(provider: Eip1193, account: Address, token: Address, spender: Address, amount: bigint) {
  const allowance = await publicClient.readContract({ address: token, abi: erc20, functionName: 'allowance', args: [account, spender] });
  if (allowance < amount) await send(provider, account, token, erc20, 'approve', [spender, amount]);
}

export async function deposit(provider: Eip1193, account: Address, amount: bigint): Promise<string> {
  await approveIfNeeded(provider, account, contracts.usdg, contracts.creditVault, amount);
  return send(provider, account, contracts.creditVault, vault, 'deposit', [amount]);
}

export async function stake(provider: Eip1193, account: Address, amount: bigint): Promise<string> {
  await approveIfNeeded(provider, account, contracts.envolvr, contracts.staking, amount);
  return send(provider, account, contracts.staking, staking, 'stake', [amount]);
}

export const requestUnstake = (provider: Eip1193, account: Address, amount: bigint) =>
  send(provider, account, contracts.staking, staking, 'requestUnstake', [amount]);
export const withdrawUnstaked = (provider: Eip1193, account: Address) =>
  send(provider, account, contracts.staking, staking, 'withdraw');
export const mintTestUsdg = (provider: Eip1193, account: Address, amount: bigint) =>
  send(provider, account, contracts.usdg, erc20, 'mint', [account, amount]);

export async function signMessage(provider: Eip1193, account: Address, message: string): Promise<string> {
  const wallet = createWalletClient({ account, chain, transport: custom(provider) });
  return wallet.signMessage({ account, message });
}
