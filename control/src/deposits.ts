// Credits USDG balances from CreditVault `Deposited` events.
//
// Polls in bounded block ranges, `confirmations` blocks behind the head, and
// commits each range's credits together with the cursor, so a crash never skips
// a deposit and a replay never credits one twice. With a `screen`, the payer and
// the credited wallet of every deposit are screened first: a deposit touching a
// blocked wallet is recorded as held instead of credited, and a range whose
// screening fails is retried later, never applied unscreened.

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { DepositEvent, Store } from './db.ts';

export const DEPOSITED_TOPIC = `0x${bytesToHex(keccak_256(utf8ToBytes('Deposited(address,address,uint256,uint256)')))}`;

export interface LogSource {
  latestBlock(): Promise<number>;
  depositLogs(fromBlock: number, toBlock: number): Promise<DepositEvent[]>;
}

interface RpcLog {
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: string;
  blockNumber: string;
  removed?: boolean;
}

const topicAddress = (t: string) => `0x${t.slice(-40)}`.toLowerCase();

export function decodeDepositLog(log: RpcLog): DepositEvent {
  if (log.topics[0]?.toLowerCase() !== DEPOSITED_TOPIC) throw new Error('not a Deposited log');
  return {
    txHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
    blockNumber: Number(BigInt(log.blockNumber)),
    account: topicAddress(log.topics[1]),
    payer: topicAddress(log.topics[2]),
    depositId: Number(BigInt(log.topics[3])),
    amountMicros: BigInt(log.data),
  };
}

export class RpcLogSource implements LogSource {
  private rpcUrl: string;
  private vault: string;

  constructor(rpcUrl: string, vault: string) {
    this.rpcUrl = rpcUrl;
    this.vault = vault;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (!res.ok || body.result === undefined) throw new Error(`${method} failed: ${body.error?.message ?? res.status}`);
    return body.result;
  }

  async latestBlock(): Promise<number> {
    return Number(BigInt(await this.rpc<string>('eth_blockNumber', [])));
  }

  async depositLogs(fromBlock: number, toBlock: number): Promise<DepositEvent[]> {
    const logs = await this.rpc<RpcLog[]>('eth_getLogs', [{
      address: this.vault,
      topics: [DEPOSITED_TOPIC],
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
    }]);
    return logs.filter((l) => !l.removed).map(decodeDepositLog);
  }
}

export class DepositWatcher {
  private store: Store;
  private source: LogSource;
  private opts: {
    cursorName: string; startBlock: number; confirmations: number; maxRange: number; now: () => number;
    screen?: (wallet: string) => Promise<boolean>;
  };

  constructor(store: Store, source: LogSource, opts: Partial<DepositWatcher['opts']> & { startBlock: number }) {
    this.store = store;
    this.source = source;
    this.opts = {
      cursorName: 'credit-vault', confirmations: 1, maxRange: 5_000, now: () => Math.floor(Date.now() / 1000), ...opts,
    };
  }

  /** Process the next block range. Returns deposits credited and held, and the block reached. */
  async pollOnce(): Promise<{ credited: number; held: number[]; throughBlock: number | undefined }> {
    const { cursorName, startBlock, confirmations, maxRange, now, screen } = this.opts;
    const from = (this.store.cursor(cursorName) ?? startBlock - 1) + 1;
    const safeHead = (await this.source.latestBlock()) - confirmations;
    if (safeHead < from) return { credited: 0, held: [], throughBlock: this.store.cursor(cursorName) };
    const to = Math.min(safeHead, from + maxRange - 1);
    const logs = await this.source.depositLogs(from, to);
    const blocked = new Set<string>();
    if (screen) {
      for (const wallet of new Set(logs.flatMap((d) => [d.account.toLowerCase(), d.payer.toLowerCase()]))) {
        if (await screen(wallet)) blocked.add(wallet);
      }
    }
    const hold = (d: DepositEvent) => blocked.has(d.account.toLowerCase()) || blocked.has(d.payer.toLowerCase());
    const credited = this.store.applyDeposits(cursorName, logs, to, now(), hold);
    return { credited, held: logs.filter(hold).map((d) => d.depositId), throughBlock: to };
  }

  /** Poll until caught up, then every `intervalMs`. */
  start(intervalMs: number, log: (msg: string, fields?: Record<string, unknown>) => void): () => void {
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        try {
          const r = await this.pollOnce();
          if (r.credited > 0) log('deposits credited', { credited: r.credited, throughBlock: r.throughBlock });
          // Count only: the logs are public, and a deposit id leads to its wallet on chain.
          if (r.held.length > 0) log('deposits held by sanctions screening', { held: r.held.length });
          const head = (await this.source.latestBlock()) - this.opts.confirmations;
          if (r.throughBlock !== undefined && r.throughBlock < head) continue;
        } catch (err) {
          log('deposit poll failed', { error: String(err) });
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    };
    void loop();
    return () => { stopped = true; };
  }
}
