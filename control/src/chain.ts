// Reads staking allowances from StakingAllowance, and the credit vault's USDG
// reserves, on Robinhood Chain.

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export interface AllowanceSource {
  /** A wallet's allowance for the UTC day starting at `dayStart`, in micro-USD. */
  allowanceMicros(wallet: string, dayStart: number): Promise<bigint>;
}

const SELECTOR = bytesToHex(keccak_256(utf8ToBytes('allowanceOf(address,uint256)'))).slice(0, 8);

function word(hex: string): string {
  return hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

export class StakingAllowanceReader implements AllowanceSource {
  private cache = new Map<string, { value: bigint; at: number }>();
  private rpcUrl: string;
  private contract: string;
  private ttlMs: number;

  constructor(rpcUrl: string, contract: string, ttlMs = 60_000) {
    this.rpcUrl = rpcUrl;
    this.contract = contract;
    this.ttlMs = ttlMs;
  }

  async allowanceMicros(wallet: string, dayStart: number): Promise<bigint> {
    const key = `${wallet.toLowerCase()}:${dayStart}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;

    const data = `0x${SELECTOR}${word(wallet)}${word(dayStart.toString(16))}`;
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: this.contract, data }, 'latest'] }),
    });
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (!res.ok || !body.result) throw new Error(`allowanceOf failed: ${body.error?.message ?? res.status}`);
    const value = BigInt(body.result);
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }
}

/** No staking configured: every allowance is zero. */
export const noAllowance: AllowanceSource = { allowanceMicros: async () => 0n };

export interface ReserveSource {
  /** USDG held by the credit vault, in micro-USD. */
  vaultUsdgMicros(): Promise<bigint>;
}

const sel = (signature: string) => bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8);

/** USDG.balanceOf(vault), with the token address read once from CreditVault.usdg(). */
export class VaultReserveReader implements ReserveSource {
  private rpcUrl: string;
  private vault: string;
  private usdg?: string;

  constructor(rpcUrl: string, vault: string) {
    this.rpcUrl = rpcUrl;
    this.vault = vault;
  }

  private async call(to: string, data: string): Promise<string> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (!res.ok || !body.result) throw new Error(`eth_call failed: ${body.error?.message ?? res.status}`);
    return body.result;
  }

  async vaultUsdgMicros(): Promise<bigint> {
    this.usdg ??= `0x${(await this.call(this.vault, `0x${sel('usdg()')}`)).slice(-40)}`;
    return BigInt(await this.call(this.usdg, `0x${sel('balanceOf(address)')}${word(this.vault)}`));
  }
}
