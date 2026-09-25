// Sanctions screening of wallets.
//
// Source: the Chainalysis sanctions oracle, a contract that lists sanctioned
// addresses (OFAC SDN) behind isSanctioned(address). It is not deployed on
// Robinhood Chain yet; an EVM address is the same on every chain, so the oracle
// is read where it is deployed (Ethereum, Arbitrum One), through independent RPC
// operators. A wallet counts as sanctioned when any source says so, and a
// lookup fails only when every source fails. The static blocklist in the config
// applies on top.
//
// Results are kept in the ledger and rescreened after `rescreenAfterSeconds`.
// Sign-in and deposits wait for a current result and fail closed when screening
// is unavailable. A request from a signed-in wallet uses the last result and
// refreshes a stale one in the background, so screening never adds latency to
// inference once a wallet is known.

import type { Store } from './db.ts';
import { decodeWords, encodeCall, Rpc } from './evm.ts';

export const CHAINALYSIS_ORACLE = '0x40C57923924B5c5c5455c48D93317139ADDaC8fb';

export interface SanctionsSource {
  readonly name: string;
  isSanctioned(wallet: string): Promise<boolean>;
}

export class OracleSource implements SanctionsSource {
  readonly name: string;
  private rpc: Rpc;
  private oracle: string;

  constructor(rpcUrl: string, oracle = CHAINALYSIS_ORACLE, timeoutMs = 10_000) {
    this.name = new URL(rpcUrl).host;
    this.rpc = new Rpc(rpcUrl, timeoutMs);
    this.oracle = oracle;
  }

  async isSanctioned(wallet: string): Promise<boolean> {
    const data = encodeCall('isSanctioned(address)', [wallet]);
    const [word] = decodeWords(await this.rpc.call<string>('eth_call', [{ to: this.oracle, data }, 'latest']));
    if (word === undefined) throw new Error(`${this.name}: empty answer from the oracle`);
    return BigInt(word) !== 0n;
  }
}

export class ScreeningUnavailable extends Error {}

type Log = (msg: string, fields?: Record<string, unknown>) => void;

export class Screening {
  private store: Store;
  private sources: SanctionsSource[];
  private blocklist: Set<string>;
  private rescreenAfter: number;
  private now: () => number;
  private log: Log;
  private refreshing = new Set<string>();

  constructor(store: Store, opts: {
    sources?: SanctionsSource[]; blocklist?: string[]; rescreenAfterSeconds?: number; now?: () => number; log?: Log;
  } = {}) {
    this.store = store;
    this.sources = opts.sources ?? [];
    this.blocklist = new Set((opts.blocklist ?? []).map((w) => w.toLowerCase()));
    this.rescreenAfter = opts.rescreenAfterSeconds ?? 86_400;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = opts.log ?? (() => {});
  }

  /** Ask every source now and record the answer. Throws ScreeningUnavailable if all fail. */
  private async lookup(wallet: string): Promise<boolean> {
    if (this.sources.length === 0) return false;
    const answers = await Promise.allSettled(this.sources.map((s) => s.isSanctioned(wallet)));
    const ok = answers.filter((a): a is PromiseFulfilledResult<boolean> => a.status === 'fulfilled');
    if (ok.length === 0) {
      throw new ScreeningUnavailable(`sanctions screening unavailable: ${answers
        .map((a, i) => `${this.sources[i].name}: ${(a as PromiseRejectedResult).reason}`).join('; ')}`);
    }
    const sanctioned = ok.some((a) => a.value);
    this.store.recordScreening(wallet, sanctioned, this.now());
    return sanctioned;
  }

  /** Blocked, from a result no older than the rescreen window (looked up if needed). */
  async check(wallet: string): Promise<boolean> {
    const w = wallet.toLowerCase();
    if (this.blocklist.has(w)) return true;
    const last = this.store.screeningResult(w);
    if (last && this.now() - last.checkedAt < this.rescreenAfter) return last.sanctioned;
    return this.lookup(w);
  }

  /**
   * Blocked, from the last result; a stale one is refreshed in the background.
   * A wallet never screened is looked up now.
   */
  async blocked(wallet: string): Promise<boolean> {
    const w = wallet.toLowerCase();
    if (this.blocklist.has(w)) return true;
    const last = this.store.screeningResult(w);
    if (!last) return this.lookup(w);
    if (this.now() - last.checkedAt >= this.rescreenAfter && !this.refreshing.has(w)) {
      this.refreshing.add(w);
      void this.lookup(w)
        .catch((err) => this.log('sanctions rescreen failed', { error: String(err) }))
        .finally(() => this.refreshing.delete(w));
    }
    return last.sanctioned;
  }
}
