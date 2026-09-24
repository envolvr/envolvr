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
  /** Encrypted off-VM ledger backups (backup.ts); off when absent. */
  backup?: BackupConfig;
  /** Bearer token the gateway presents (middleware.control_token). */
  controlToken: string;
  /** Bearer token for /admin endpoints. */
  adminToken: string;
}

export interface BackupConfig {
  /** S3-compatible endpoint, e.g. https://s3.us-east-005.backblazeb2.com */
  endpoint: string;
  bucket: string;
  /** The endpoint's signing region, e.g. us-east-005 (B2), auto (R2). */
  region: string;
  /** Object key prefix, one per ledger (e.g. "control-db/"). */
  prefix: string;
  /** Default 300000 (5 minutes). */
  intervalMs?: number;
  /** Default 30. */
  retainDays?: number;
  /** Default /var/run/dstack.sock. */
  dstackEndpoint?: string;
  /** Restore this backup instead of the newest (applies only when dbPath does not exist). */
  restoreKey?: string;
  /** From the environment only: BACKUP_ACCESS_KEY_ID, BACKUP_SECRET_ACCESS_KEY. */
  accessKeyId: string;
  secretAccessKey: string;
}

type FileConfig = Omit<Config, 'controlToken' | 'adminToken' | 'blockedWallets' | 'backup'> & {
  blockedWallets?: string[];
  backup?: Omit<BackupConfig, 'accessKeyId' | 'secretAccessKey'>;
};

/** Settings from a JSON file; tokens and storage credentials from the environment only. */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const { backup, ...file } = JSON.parse(readFileSync(path, 'utf8')) as FileConfig;
  const controlToken = env.CONTROL_TOKEN;
  const adminToken = env.ADMIN_TOKEN;
  if (!controlToken || controlToken.length < 32) throw new Error('CONTROL_TOKEN must be set (32+ chars)');
  if (!adminToken || adminToken.length < 32) throw new Error('ADMIN_TOKEN must be set (32+ chars)');
  validateModels(file.models);
  const config: Config = { blockedWallets: [], ...file, controlToken, adminToken };
  if (backup) {
    const { BACKUP_ACCESS_KEY_ID: accessKeyId, BACKUP_SECRET_ACCESS_KEY: secretAccessKey } = env;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('backup is configured: BACKUP_ACCESS_KEY_ID and BACKUP_SECRET_ACCESS_KEY must be set');
    }
    if (!backup.endpoint || !backup.bucket || !backup.region) throw new Error('backup needs endpoint, bucket and region');
    if (!backup.prefix || !backup.prefix.endsWith('/')) throw new Error('backup.prefix must end with "/"');
    config.backup = { ...backup, accessKeyId, secretAccessKey };
  }
  return config;
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
