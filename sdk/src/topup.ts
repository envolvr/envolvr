// Automatic top-up: keep an account funded from a wallet, within a daily cap.
//
// Before a request (at most every `checkEveryMs`), and whenever the gateway
// answers 402 insufficient credit, the client reads the account. When the
// staking allowance left plus the USDG balance is below `below`, it deposits
// `amount` from `signer` (for the account's own wallet, or with depositFor when
// the signer is another wallet, such as the person funding an agent) and waits
// until the control plane has credited it. Concurrent requests share one
// top-up. Deposits per UTC day stop at `maxPerDay` (default: one top-up), as
// counted by this process.

import { type Account, depositUsdg, getAccount } from './api.ts';
import { fromMicros, type Network, toMicros } from './network.ts';
import type { Signer } from './wallet.ts';

export interface AutoTopUpOptions {
  /** The wallet that pays: it needs USDG, and a little ETH for gas. */
  signer: Signer;
  /** Top up when allowance left plus balance falls below this, USD (for example '5'). */
  below: string;
  /** How much to deposit each time, USD. The account is credited net of the deposit fee. */
  amount: string;
  /** Most to deposit per UTC day, USD. Defaults to `amount`: one top-up a day. */
  maxPerDay?: string;
  /** How often to read the account before a request, ms. Default 30 000. */
  checkEveryMs?: number;
  /** How long to wait for a mined deposit to be credited, ms. Default 120 000. */
  creditTimeoutMs?: number;
  /** Told about every top-up, skip and failure. */
  onEvent?: (event: TopUpEvent) => void;
}

export type TopUpEvent =
  | { type: 'topped-up'; amountMicros: bigint; depositTx: string; creditedMicros: bigint }
  | { type: 'capped'; availableMicros: bigint; spentTodayMicros: bigint; maxPerDayMicros: bigint }
  | { type: 'failed'; error: Error };

const DAY_MS = 86_400_000;
const available = (a: Account) => BigInt(a.balanceMicros) + BigInt(a.allowanceLeftMicros);

export class AutoTopUp {
  private readonly opts: AutoTopUpOptions;
  private readonly below: bigint;
  private readonly amount: bigint;
  private readonly maxPerDay: bigint;
  private lastCheck = 0;
  private running: Promise<void> | undefined;
  private day = -1;
  private spentToday = 0n;
  private cappedNoticeDay = -1;
  private toppedUp = 0;

  private readonly apiKey: string;
  private readonly network: Network;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<unknown>;

  constructor(opts: AutoTopUpOptions, apiKey: string, network: Network,
    clock: { now?: () => number; sleep?: (ms: number) => Promise<unknown> } = {}) {
    this.opts = opts;
    this.apiKey = apiKey;
    this.network = network;
    this.now = clock.now ?? Date.now;
    this.sleep = clock.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.below = toMicros(opts.below);
    this.amount = toMicros(opts.amount);
    this.maxPerDay = toMicros(opts.maxPerDay ?? opts.amount);
    if (this.amount <= 0n) throw new Error('autoTopUp.amount must be positive');
    if (this.maxPerDay < this.amount) throw new Error('autoTopUp.maxPerDay must be at least autoTopUp.amount');
  }

  /** Before a request: read the account at most every `checkEveryMs`, top up if it is low. */
  async beforeRequest(): Promise<void> {
    if (this.running) return this.running;
    if (this.now() - this.lastCheck < (this.opts.checkEveryMs ?? 30_000)) return;
    return this.ensure();
  }

  /**
   * After a 402: read the account now, whatever the interval, and top up if it is
   * low. True when a top-up was credited, so the request can be retried.
   */
  async afterInsufficientCredit(): Promise<boolean> {
    const toppedUp = this.toppedUp;
    await this.ensure();
    return this.toppedUp > toppedUp;
  }

  private ensure(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run(): Promise<void> {
    try {
      this.lastCheck = this.now();
      const account = await getAccount(this.apiKey, this.network);
      const have = available(account);
      if (have >= this.below) return;
      const day = Math.floor(this.now() / DAY_MS);
      if (day !== this.day) { this.day = day; this.spentToday = 0n; }
      if (this.spentToday + this.amount > this.maxPerDay) {
        if (this.cappedNoticeDay !== day) {
          this.cappedNoticeDay = day;
          this.opts.onEvent?.({ type: 'capped', availableMicros: have, spentTodayMicros: this.spentToday, maxPerDayMicros: this.maxPerDay });
        }
        return;
      }
      const { depositTx, expectedCreditMicros } = await depositUsdg({
        signer: this.opts.signer, amountMicros: this.amount, account: account.wallet, network: this.network,
      });
      this.spentToday += this.amount;
      // The deposit is mined; wait until the control plane has credited it.
      const target = BigInt(account.balanceMicros) + expectedCreditMicros;
      const deadline = this.now() + (this.opts.creditTimeoutMs ?? 120_000);
      let credited = 0n;
      while (this.now() < deadline) {
        const a = await getAccount(this.apiKey, this.network);
        credited = BigInt(a.balanceMicros) - BigInt(account.balanceMicros);
        if (BigInt(a.balanceMicros) >= target) break;
        await this.sleep(3_000);
      }
      if (credited < expectedCreditMicros) {
        throw new Error(`deposit ${depositTx} was mined but ${fromMicros(expectedCreditMicros)} USD was not credited within the timeout`);
      }
      this.toppedUp++;
      this.opts.onEvent?.({ type: 'topped-up', amountMicros: this.amount, depositTx, creditedMicros: credited });
    } catch (err) {
      this.opts.onEvent?.({ type: 'failed', error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
}
