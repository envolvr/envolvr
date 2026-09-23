import { readFileSync } from 'node:fs';
import type { Rates } from './money.ts';

export interface Config {
  port: number;
  dbPath: string;
  /** Upstream name in the gateway's upstream config; route ids are `<upstream>:<model>`. */
  upstreamName: string;
  /** Resale margin over upstream list price, in basis points. */
  marginBps: number;
  /** Deny below this much available credit (allowance left plus balance), micro-USD. */
  minAvailableMicros: number;
  /** Upstream list prices per model, USD per token as decimal strings. */
  models: Record<string, Rates>;
  chain?: {
    rpcUrl: string;
    stakingAllowance: string;
    /** CreditVault address; when set, USDG deposits are credited automatically. */
    creditVault?: string;
    /** Block the vault was deployed in; the watcher starts here. */
    depositStartBlock?: number;
    confirmations?: number;
    depositPollMs?: number;
  };
  blockedWallets: string[];
  /** Bearer token the gateway presents (middleware.control_token). */
  controlToken: string;
  /** Bearer token for /admin endpoints. */
  adminToken: string;
}

/** Settings from a JSON file; the two tokens from the environment only. */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = JSON.parse(readFileSync(path, 'utf8')) as Omit<Config, 'controlToken' | 'adminToken'>;
  const controlToken = env.CONTROL_TOKEN;
  const adminToken = env.ADMIN_TOKEN;
  if (!controlToken || controlToken.length < 32) throw new Error('CONTROL_TOKEN must be set (32+ chars)');
  if (!adminToken || adminToken.length < 32) throw new Error('ADMIN_TOKEN must be set (32+ chars)');
  return { blockedWallets: [], ...file, controlToken, adminToken };
}
