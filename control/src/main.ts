// node src/main.ts   (CONTROL_CONFIG, CONTROL_TOKEN, ADMIN_TOKEN from the environment;
// BACKUP_ACCESS_KEY_ID, BACKUP_SECRET_ACCESS_KEY when backups are configured)

import { existsSync } from 'node:fs';
import { Anchorer, anchorKey, ReceiptAnchorContract } from './anchoring.ts';
import { LedgerBackups, ledgerBackupKey } from './backup.ts';
import { loadConfig } from './config.ts';
import { noAllowance, StakingAllowanceReader } from './chain.ts';
import { Store } from './db.ts';
import { DepositWatcher, RpcLogSource } from './deposits.ts';
import { Rpc } from './evm.ts';
import { S3Client } from './s3.ts';
import { OracleSource, Screening } from './screening.ts';
import { createControlServer } from './server.ts';

const config = loadConfig(process.env.CONTROL_CONFIG ?? 'config.json');
const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));

let backups: LedgerBackups | undefined;
if (config.backup) {
  const b = config.backup;
  const s3 = new S3Client({
    endpoint: b.endpoint, bucket: b.bucket, region: b.region,
    accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey,
  });
  const key = await ledgerBackupKey(b.dstackEndpoint ?? '/var/run/dstack.sock');
  backups = new LedgerBackups(s3, key, { prefix: b.prefix, retainDays: b.retainDays, log });
  if (!existsSync(config.dbPath)) {
    const restored = await backups.restore(config.dbPath, b.restoreKey);
    if (!restored) log('no ledger backup found; starting a new ledger', { prefix: b.prefix });
  } else {
    // Runs ahead of this run's first backup, so it checks the previous run's copy.
    void backups.verifyLatest(config.dbPath).then(
      (checked) => checked && log('ledger backup verified', { backup: checked }),
      (err) => log('ledger backup verify failed', { error: String(err) }),
    );
  }
}

const store = new Store(config.dbPath);
const allowance = config.chain
  ? new StakingAllowanceReader(config.chain.rpcUrl, config.chain.stakingAllowance)
  : noAllowance;

const screening = new Screening(store, {
  sources: (config.screening?.oracleRpcUrls ?? []).map((url) => new OracleSource(url, config.screening?.oracle)),
  blocklist: config.blockedWallets,
  rescreenAfterSeconds: config.screening?.rescreenAfterSeconds,
  log,
});
if (config.screening) log('sanctions screening configured', { sources: config.screening.oracleRpcUrls.map((u) => new URL(u).host) });

let stopDeposits = () => {};
if (config.chain?.creditVault) {
  const source = new RpcLogSource(config.chain.rpcUrl, config.chain.creditVault);
  stopDeposits = new DepositWatcher(store, source, {
    startBlock: config.chain.depositStartBlock ?? 0,
    confirmations: config.chain.confirmations ?? 1,
    screen: (wallet) => screening.check(wallet),
  }).start(config.chain.depositPollMs ?? 5_000, log);
  log('deposit watcher started', { vault: config.chain.creditVault });
}

let stopAnchoring = () => {};
if (config.anchoring) {
  const a = config.anchoring;
  const contract = new ReceiptAnchorContract({
    rpc: new Rpc(config.chain!.rpcUrl), contract: a.receiptAnchor, providerId: a.providerId, chainId: a.chainId,
    key: await anchorKey(a.dstackEndpoint ?? '/var/run/dstack.sock'),
  });
  stopAnchoring = new Anchorer(store, contract, { intervalMs: a.intervalMs, maxBatch: a.maxBatch, log })
    .start(a.pollMs ?? 30_000);
  log('receipt anchoring configured', { contract: a.receiptAnchor, providerId: a.providerId, anchorer: contract.address });
}

const stopBackups = backups?.start(store.db, config.dbPath, config.backup?.intervalMs ?? 300_000);
if (backups) log('ledger backups started', { bucket: config.backup!.bucket, prefix: config.backup!.prefix });

const server = createControlServer({ config, store, allowance, screening, log }).listen(config.port, () =>
  log('control plane listening', { port: config.port, models: Object.keys(config.models) }),
);

// On stop: refuse new requests, finish in-flight ones, take a final backup.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    log('stopping', { signal });
    stopDeposits();
    stopAnchoring();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopBackups?.();
    store.close();
    process.exit(0);
  });
}
