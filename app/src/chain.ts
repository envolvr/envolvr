// Robinhood Chain: balances and staking state (read over the public RPC), and
// the transactions the wallet signs (approve, deposit, stake, unstake, withdraw,
// and, with TESTNET, a test USDG mint).

import { createPublicClient, createWalletClient, custom, http, parseAbi, zeroAddress, type Address } from 'viem';
import { chain, contracts } from './config.ts';
import type { Eip1193 } from './wallet.ts';

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
]);
const vault = parseAbi([
  'function deposit(uint256 amount)',
  'function depositFor(address account, uint256 amount)',
  'function keeper() view returns (address)',
  'function topUpRules(address payer, address account) view returns (uint128 below, uint128 amount, uint128 maxPerDay, uint64 day, uint128 spentToday)',
  'function setTopUpRule(address account, uint256 below, uint256 amount, uint256 maxPerDay)',
]);
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
  nvlr: bigint;
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
  // NVLR and staking are not deployed yet: their reads count as zero until they are.
  const hasToken = contracts.nvlr !== zeroAddress;
  const hasStaking = contracts.staking !== zeroAddress;
  const stakingRead = <T>(functionName: string, args: unknown[], none: T) =>
    hasStaking ? read<T>(contracts.staking, staking, functionName, args) : Promise.resolve(none);
  const day = await stakingRead<bigint>('currentDayStart', [], 0n);
  const [usdg, nvlr, staked, totalStake, pending, budgetToday, allowanceToday, cooldown, eth] = await Promise.all([
    read<bigint>(contracts.usdg, erc20, 'balanceOf', [address]),
    hasToken ? read<bigint>(contracts.nvlr, erc20, 'balanceOf', [address]) : Promise.resolve(0n),
    stakingRead<bigint>('stakeOf', [address], 0n),
    stakingRead<bigint>('totalStake', [], 0n),
    stakingRead<readonly [bigint, number]>('pendingUnstake', [address], [0n, 0]),
    stakingRead<bigint>('budgetAt', [day], 0n),
    stakingRead<bigint>('allowanceOf', [address, day], 0n),
    stakingRead<bigint>('cooldown', [], 0n),
    publicClient.getBalance({ address }),
  ]);
  return {
    usdg, nvlr, staked, totalStake, pending: { amount: pending[0], unlocksAt: Number(pending[1]) }, budgetToday, allowanceToday,
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

export interface TopUpRule { below: bigint; amount: bigint; maxPerDay: bigint; spentToday: bigint; keeperActive: boolean }

/** The connected wallet's top-up rule for `account`, and whether the vault has a keeper. */
export async function readTopUpRule(payer: Address, account: Address): Promise<TopUpRule> {
  const [rule, keeper] = await Promise.all([
    publicClient.readContract({ address: contracts.creditVault, abi: vault, functionName: 'topUpRules', args: [payer, account] }),
    publicClient.readContract({ address: contracts.creditVault, abi: vault, functionName: 'keeper' }),
  ]);
  const [below, amount, maxPerDay, day, spent] = rule;
  const today = BigInt(Math.floor(Date.now() / 86_400_000));
  return { below, amount, maxPerDay, spentToday: day === today ? spent : 0n, keeperActive: !/^0x0{40}$/i.test(keeper) };
}

/**
 * Store a top-up rule. The vault pulls USDG from this wallet when the account
 * runs low, so it is approved first for up to 30 days at the daily cap.
 */
export async function setTopUpRule(provider: Eip1193, payer: Address, account: Address, below: bigint, amount: bigint, maxPerDay: bigint) {
  await approveIfNeeded(provider, payer, contracts.usdg, contracts.creditVault, maxPerDay * 30n);
  return send(provider, payer, contracts.creditVault, vault, 'setTopUpRule', [account, below, amount, maxPerDay]);
}

export const clearTopUpRule = (provider: Eip1193, payer: Address, account: Address) =>
  send(provider, payer, contracts.creditVault, vault, 'setTopUpRule', [account, 0n, 0n, 0n]);

export async function stake(provider: Eip1193, account: Address, amount: bigint): Promise<string> {
  await approveIfNeeded(provider, account, contracts.nvlr, contracts.staking, amount);
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
