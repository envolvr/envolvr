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
  /** Sanctions screening (screening.ts); only `blockedWallets` applies when absent. */
  screening?: ScreeningConfig;
  /** Encrypted off-VM ledger backups (backup.ts); off when absent. */
  backup?: BackupConfig;
  /** Receipt anchoring on chain (anchoring.ts); needs `chain`. Off when absent. */
  anchoring?: AnchoringConfig;
  /** Bearer token the gateway presents (middleware.control_token). */
  controlToken: string;
  /** Bearer token for /admin endpoints. */
  adminToken: string;
}

export interface ScreeningConfig {
  /** JSON-RPC endpoints of chains where the Chainalysis sanctions oracle is deployed; any "sanctioned" answer counts. */
  oracleRpcUrls: string[];
  /** Default 0x40C57923924B5c5c5455c48D93317139ADDaC8fb (the same on every chain it is deployed on). */
  oracle?: string;
  /** Default 86400. */
  rescreenAfterSeconds?: number;
}

export interface AnchoringConfig {
  /** ReceiptAnchor contract address. */
  receiptAnchor: string;
  /** This gateway's log: keccak256("envolvr.provider:<dstack app id>"). */
  providerId: string;
  /** Checked against the RPC before every transaction. */
  chainId: number;
  /** Slot length, whole seconds, at least a minute. Default 600000 (10 minutes). */
  intervalMs?: number;
  /** Default 30000. */
  pollMs?: number;
  /** Default 100000. */
  maxBatch?: number;
  /** Default /var/run/dstack.sock. */
  dstackEndpoint?: string;
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
  if (config.anchoring) validateAnchoring(config);
  if (config.screening) {
    const urls = config.screening.oracleRpcUrls;
    if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => /^https?:\/\//.test(u))) {
      throw new Error('screening.oracleRpcUrls must list at least one http(s) URL');
    }
  }
  return config;
}

function validateAnchoring(config: Config): void {
  const a = config.anchoring!;
  if (!config.chain?.rpcUrl) throw new Error('anchoring needs chain.rpcUrl');
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.receiptAnchor ?? '')) throw new Error('anchoring.receiptAnchor must be an address');
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.providerId ?? '')) throw new Error('anchoring.providerId must be 32 bytes of hex');
  if (!Number.isInteger(a.chainId) || a.chainId <= 0) throw new Error('anchoring.chainId must be a positive integer');
  const interval = a.intervalMs ?? 600_000;
  if (!Number.isInteger(interval) || interval < 60_000 || interval % 1000 !== 0) {
    throw new Error('anchoring.intervalMs must be whole seconds and at least 60000');
  }
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
