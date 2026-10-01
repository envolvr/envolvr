// Move earned USDG out of the credit vault, as its owner: to pay a supplier or
// to sweep to the treasury.
//
//   CONTROL_URL=https://auth.envolvr.xyz ADMIN_TOKEN=… OWNER_PRIVATE_KEY=… \
//     node --disable-warning=ExperimentalWarning scripts/withdraw.ts <to> <usd | all> [--send]
//
// The vault holds users' unspent balances, unpaid refunds and held deposits next
// to what envolvr has earned (spent balances and deposit fees). Only the surplus
// over what is owed, GET /admin/reserves `withdrawableMicros`, may leave here;
// anything more is refused. `all` withdraws the whole surplus. Without --send it
// only prints the reserves and what it would do. RPC_URL, CHAIN_ID and
// CREDIT_VAULT default to Robinhood Chain testnet.

import { owner, printReserves, reserves, usd, withdraw } from './vault.ts';

const [to, amount] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const send = process.argv.includes('--send');
if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to) || !amount) {
  throw new Error('usage: withdraw.ts <to address> <usd amount | all> [--send]');
}

const r = await reserves();
printReserves(r);
if (r.withdrawableMicros === null) throw new Error('the control plane has no vault configured: cannot check the reserves');
const surplus = BigInt(r.withdrawableMicros);
let micros: bigint;
if (amount === 'all') micros = surplus;
else {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount);
  if (!m) throw new Error(`not a USD amount with at most 6 decimals: ${amount}`);
  micros = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}
if (micros <= 0n) throw new Error('nothing to withdraw');
if (micros > surplus) throw new Error(`refused: ${usd(micros)} is more than the withdrawable ${usd(surplus)}; the rest is owed to users`);

console.log(`withdraw ${usd(micros)} -> ${to}`);
if (!send) { console.log('dry run: add --send to withdraw'); process.exit(0); }
const hash = await withdraw(await owner(), to, micros);
console.log(`withdrawn ${usd(micros)} -> ${to}: ${hash}`);
printReserves(await reserves());
