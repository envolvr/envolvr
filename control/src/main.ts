// node src/main.ts   (CONTROL_CONFIG, CONTROL_TOKEN, ADMIN_TOKEN from the environment)

import { loadConfig } from './config.ts';
import { noAllowance, StakingAllowanceReader } from './chain.ts';
import { Store } from './db.ts';
import { DepositWatcher, RpcLogSource } from './deposits.ts';
import { createControlServer } from './server.ts';

const config = loadConfig(process.env.CONTROL_CONFIG ?? 'config.json');
const store = new Store(config.dbPath);
const allowance = config.chain
  ? new StakingAllowanceReader(config.chain.rpcUrl, config.chain.stakingAllowance)
  : noAllowance;
const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));

if (config.chain?.creditVault) {
  const source = new RpcLogSource(config.chain.rpcUrl, config.chain.creditVault);
  new DepositWatcher(store, source, {
    startBlock: config.chain.depositStartBlock ?? 0,
    confirmations: config.chain.confirmations ?? 1,
  }).start(config.chain.depositPollMs ?? 5_000, log);
  log('deposit watcher started', { vault: config.chain.creditVault });
}

createControlServer({ config, store, allowance, log }).listen(config.port, () =>
  log('control plane listening', { port: config.port, models: Object.keys(config.models) }),
);
