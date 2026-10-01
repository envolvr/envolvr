// Automatic top-up keeper for CreditVault rules.
//
// A payer stores a rule on chain (CreditVault.setTopUpRule: top up `amount`
// when the account's credit falls below `below`, at most `maxPerDay` a UTC day)
// and approves the vault for USDG. The keeper follows TopUpRuleSet events into
// the ledger and, after every billed request for an account with a rule and on
// a regular sweep, compares the account's credit (USDG balance plus the
// allowance left today) with `below`. When it is low it calls
// CreditVault.topUp(payer, account) with a key only this attested VM can derive.
// The vault pulls exactly the rule's amount into the rule's account within the
// cap; the deposit watcher then credits the Deposited event like any deposit.
//
// It never sends a transaction bound to fail: before each one it checks the
// payer's screening, the rule and its cap on chain, and the payer's USDG and
// approval. A sent top-up is not repeated for `retryAfterSeconds`, the time it
// takes to be mined and credited.

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { AllowanceSource } from './chain.ts';
import type { Store, TopUpRule, TopUpRuleEvent } from './db.ts';
import { dstackKey } from './dstack.ts';
import { addressOfKey, decodeWords, encodeCall, Rpc, signTx } from './evm.ts';

export const KEEPER_KMS_PATH = 'envolvr/control/topup-keeper';
export const TOPUP_RULE_TOPIC = `0x${bytesToHex(keccak_256(utf8ToBytes('TopUpRuleSet(address,address,uint256,uint256,uint256)')))}`;
const DAY = 86_400;

/** The keeper's key: a secp256k1 key the dstack KMS derives for this app. */
export async function keeperKey(dstackEndpoint: string): Promise<Uint8Array> {
  const key = new Uint8Array(await dstackKey(dstackEndpoint, KEEPER_KMS_PATH, 'signing'));
  if (!secp256k1.utils.isValidPrivateKey(key)) throw new Error('dstack key is not a valid secp256k1 key');
  return key;
}

export interface OnChainRule {
  belowMicros: bigint;
  amountMicros: bigint;
  maxPerDayMicros: bigint;
  day: number;
  spentTodayMicros: bigint;
}

/** What the keeper needs from the chain. */
export interface TopUpChain {
  readonly address: string;
  latestBlock(): Promise<number>;
  ruleLogs(fromBlock: number, toBlock: number): Promise<TopUpRuleEvent[]>;
  rule(payer: string, account: string): Promise<OnChainRule>;
  usdgBalance(owner: string): Promise<bigint>;
  usdgAllowance(owner: string): Promise<bigint>;
  /** Send topUp(payer, account); returns the transaction hash. */
  sendTopUp(payer: string, account: string): Promise<string>;
}

const topicAddress = (t: string) => `0x${t.slice(-40)}`.toLowerCase();

export class VaultTopUpContract implements TopUpChain {
  readonly address: string;
  private rpc: Rpc;
  private vault: string;
  private chainId: bigint;
  private key: Uint8Array;
  private usdg?: string;

  constructor(opts: { rpc: Rpc; vault: string; chainId: number; key: Uint8Array }) {
    this.rpc = opts.rpc;
    this.vault = opts.vault;
    this.chainId = BigInt(opts.chainId);
    this.key = opts.key;
    this.address = addressOfKey(opts.key);
  }

  private async view(to: string, signature: string, args: (bigint | string)[]): Promise<string[]> {
    return decodeWords(await this.rpc.call<string>('eth_call', [{ to, data: encodeCall(signature, args) }, 'latest']));
  }

  private async token(): Promise<string> {
    this.usdg ??= `0x${(await this.view(this.vault, 'usdg()', []))[0].slice(-40)}`;
    return this.usdg;
  }

  async latestBlock(): Promise<number> {
    return Number(BigInt(await this.rpc.call<string>('eth_blockNumber', [])));
  }

  async ruleLogs(fromBlock: number, toBlock: number): Promise<TopUpRuleEvent[]> {
    const logs = await this.rpc.call<{ topics: string[]; data: string; logIndex: string; blockNumber: string; removed?: boolean }[]>(
      'eth_getLogs', [{
        address: this.vault, topics: [TOPUP_RULE_TOPIC],
        fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`,
      }]);
    return logs.filter((l) => !l.removed).map((l) => {
      const [below, amount, maxPerDay] = decodeWords(l.data);
      return {
        payer: topicAddress(l.topics[1]), account: topicAddress(l.topics[2]),
        belowMicros: BigInt(below), amountMicros: BigInt(amount), maxPerDayMicros: BigInt(maxPerDay),
        blockNumber: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex)),
      };
    });
  }

  async rule(payer: string, account: string): Promise<OnChainRule> {
    const [below, amount, maxPerDay, day, spent] = await this.view(this.vault, 'topUpRules(address,address)', [payer, account]);
    return {
      belowMicros: BigInt(below), amountMicros: BigInt(amount), maxPerDayMicros: BigInt(maxPerDay),
      day: Number(BigInt(day)), spentTodayMicros: BigInt(spent),
    };
  }

  async usdgBalance(owner: string): Promise<bigint> {
    return BigInt((await this.view(await this.token(), 'balanceOf(address)', [owner]))[0]);
  }

  async usdgAllowance(owner: string): Promise<bigint> {
    return BigInt((await this.view(await this.token(), 'allowance(address,address)', [owner, this.vault]))[0]);
  }

  async sendTopUp(payer: string, account: string): Promise<string> {
    const chainId = BigInt(await this.rpc.call<string>('eth_chainId', []));
    if (chainId !== this.chainId) throw new Error(`RPC is on chain ${chainId}, expected ${this.chainId}`);
    const data = encodeCall('topUp(address,address)', [payer, account]);
    const call = { from: this.address, to: this.vault, data };
    const [nonce, gas, block] = await Promise.all([
      this.rpc.call<string>('eth_getTransactionCount', [this.address, 'pending']),
      this.rpc.call<string>('eth_estimateGas', [call]),
      this.rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]),
    ]);
    const priority = await this.rpc.call<string>('eth_maxPriorityFeePerGas', []).then(BigInt, () => 0n);
    const baseFee = BigInt(block.baseFeePerGas ?? (await this.rpc.call<string>('eth_gasPrice', [])));
    const { raw, hash } = signTx({
      chainId, nonce: BigInt(nonce), maxPriorityFeePerGas: priority, maxFeePerGas: baseFee * 2n + priority,
      gas: (BigInt(gas) * 13n) / 10n, to: this.vault, value: 0n, data,
    }, this.key);
    const sent = await this.rpc.call<string>('eth_sendRawTransaction', [raw]);
    if (sent.toLowerCase() !== hash) throw new Error(`node returned tx hash ${sent}, expected ${hash}`);
    return hash;
  }
}

type Log = (msg: string, fields?: Record<string, unknown>) => void;

export type CheckResult = 'ok' | 'sent' | 'pending' | 'capped' | 'no-funds' | 'no-rule' | 'blocked' | 'failed';

export class TopUpKeeper {
  private store: Store;
  private chain: TopUpChain;
  private allowance: AllowanceSource;
  private opts: {
    cursorName: string; startBlock: number; confirmations: number; maxRange: number; retryAfterSeconds: number;
    now: () => number; log: Log; screen?: (wallet: string) => Promise<boolean>;
  };
  /** (payer:account) -> when a top-up was last sent. */
  private sent = new Map<string, number>();
  /** Accounts being checked, so concurrent reports share one check. */
  private checking = new Map<string, Promise<CheckResult[]>>();

  constructor(store: Store, chain: TopUpChain, allowance: AllowanceSource,
    opts: Partial<TopUpKeeper['opts']> & { startBlock: number }) {
    this.store = store;
    this.chain = chain;
    this.allowance = allowance;
    this.opts = {
      cursorName: 'topup-rules', confirmations: 1, maxRange: 5_000, retryAfterSeconds: 600,
      now: () => Math.floor(Date.now() / 1000), log: () => {}, ...opts,
    };
  }

  /** Follow TopUpRuleSet events into the ledger, one bounded range per call. */
  async syncRules(): Promise<number | undefined> {
    const { cursorName, startBlock, confirmations, maxRange } = this.opts;
    const from = (this.store.cursor(cursorName) ?? startBlock - 1) + 1;
    const safeHead = (await this.chain.latestBlock()) - confirmations;
    if (safeHead < from) return this.store.cursor(cursorName);
    const to = Math.min(safeHead, from + maxRange - 1);
    this.store.applyTopUpRules(cursorName, await this.chain.ruleLogs(from, to), to);
    return to;
  }

  /** The account's credit now: USDG balance plus the staking allowance left today. */
  private async credit(wallet: string): Promise<bigint> {
    const account = this.store.accountByWallet(wallet);
    const t = this.opts.now();
    const dayStart = t - (t % DAY);
    const balance = account?.balanceMicros ?? 0n;
    const total = await this.allowance.allowanceMicros(wallet, dayStart).catch(() => 0n);
    const left = account ? total - this.store.allowanceUsed(account.id, dayStart) : total;
    return balance + (left > 0n ? left : 0n);
  }

  /** Check every rule funding `wallet`; send a top-up where one is due. Concurrent calls share one check. */
  check(wallet: string): Promise<CheckResult[]> {
    const key = wallet.toLowerCase();
    let running = this.checking.get(key);
    if (!running) {
      running = this.run(key).finally(() => this.checking.delete(key));
      this.checking.set(key, running);
    }
    return running;
  }

  private async run(wallet: string): Promise<CheckResult[]> {
    const rules = this.store.topUpRules(wallet);
    if (rules.length === 0) return [];
    const credit = await this.credit(wallet);
    const results: CheckResult[] = [];
    for (const rule of rules) {
      if (credit >= rule.belowMicros) { results.push('ok'); continue; }
      const r = await this.topUp(rule);
      results.push(r);
      if (r === 'sent' || r === 'pending') break; // one top-up at a time per account
    }
    return results;
  }

  private async topUp(rule: TopUpRule): Promise<CheckResult> {
    const { now, log, retryAfterSeconds, screen } = this.opts;
    const id = `${rule.payer}:${rule.account}`;
    const last = this.sent.get(id);
    if (last !== undefined && now() - last < retryAfterSeconds) return 'pending';
    try {
      if (screen && (await screen(rule.payer))) {
        log('top-up skipped: payer blocked by screening', { account: rule.account });
        return 'blocked';
      }
      const onChain = await this.chain.rule(rule.payer, rule.account);
      if (onChain.amountMicros === 0n) return 'no-rule';
      const today = Math.floor(now() / DAY);
      const spent = onChain.day === today ? onChain.spentTodayMicros : 0n;
      if (spent + onChain.amountMicros > onChain.maxPerDayMicros) return 'capped';
      const [balance, approved] = await Promise.all([
        this.chain.usdgBalance(rule.payer), this.chain.usdgAllowance(rule.payer),
      ]);
      if (balance < onChain.amountMicros || approved < onChain.amountMicros) {
        log('top-up skipped: the payer lacks USDG or approval', { account: rule.account });
        return 'no-funds';
      }
      const tx = await this.chain.sendTopUp(rule.payer, rule.account);
      this.sent.set(id, now());
      log('top-up sent', { account: rule.account, amountMicros: onChain.amountMicros.toString(), tx });
      return 'sent';
    } catch (err) {
      log('top-up failed', { account: rule.account, error: String(err) });
      return 'failed';
    }
  }

  /** Sync the rules, then check every account that has one. */
  async sweep(): Promise<void> {
    await this.syncRules();
    for (const account of new Set(this.store.topUpRules().map((r) => r.account))) await this.check(account);
  }

  /** Sweep now and every `intervalMs`; returns a stop function. */
  start(intervalMs: number): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const loop = async () => {
      try { await this.sweep(); } catch (err) { this.opts.log('top-up sweep failed', { error: String(err) }); }
      if (!stopped) timer = setTimeout(loop, intervalMs);
    };
    void loop();
    return () => { stopped = true; clearTimeout(timer); };
  }
}
