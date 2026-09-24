import { readFileSync } from 'node:fs';
import { toPico } from './money.ts';
import type { ModelRoutes } from './routing.ts';

export interface Config {
  port: number;
  dbPath: string;
  /** Resale margin over upstream list price, in basis points. */
  marginBps: number;
  /** Deny below this much available credit (allowance left plus balance), micro-USD. */
  minAvailableMicros: number;
  /**
   * Public models and their attested routes in failover order. Each route names
   * an upstream in the gateway's upstream config (route id `<upstream>:<model>`)
   * and its list prices, USD per token as decimal strings.
   */
  models: Record<string, ModelRoutes>;
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
  validateModels(file.models);
  return { blockedWallets: [], ...file, controlToken, adminToken };
}

export function validateModels(models: Record<string, ModelRoutes>): void {
  if (!models || typeof models !== 'object') throw new Error('models must be an object');
  for (const [model, entry] of Object.entries(models)) {
    const routes = entry?.routes;
    if (!Array.isArray(routes) || routes.length === 0) throw new Error(`${model}: routes must be a non-empty list`);
    const seen = new Set<string>();
    for (const r of routes) {
      if (typeof r.upstream !== 'string' || !r.upstream) throw new Error(`${model}: every route needs an upstream`);
      if (seen.has(r.upstream)) throw new Error(`${model}: duplicate route ${r.upstream}`);
      seen.add(r.upstream);
      for (const rate of [r.inputCostPerToken, r.outputCostPerToken, r.cacheReadCostPerToken, r.cacheCreationCostPerToken]) {
        if (rate !== undefined) toPico(rate);
      }
      if (r.inputCostPerToken === undefined || r.outputCostPerToken === undefined) {
        throw new Error(`${model}/${r.upstream}: input and output rates are required`);
      }
    }
    if (routes.every((r) => r.optIn)) throw new Error(`${model}: needs at least one route that is not opt-in`);
  }
}
