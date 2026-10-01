// Pay the refunds of closed accounts from the credit vault, as its owner.
//
//   CONTROL_URL=https://auth.envolvr.xyz ADMIN_TOKEN=… OWNER_PRIVATE_KEY=… \
//     node --disable-warning=ExperimentalWarning scripts/pay-refunds.ts [--send]
//
// Lists pending refunds and, with --send, pays each one with
// CreditVault.withdraw(refundTo, amount) from the owner key, waits for it to be
// mined, and records it as paid. Without --send it only prints what it would
// pay. RPC_URL, CHAIN_ID and CREDIT_VAULT default to Robinhood Chain testnet.
// Held refunds (flagged by sanctions screening) are never paid here. Refunds
// are part of what the vault owes, so they are paid even when the vault holds
// no surplus; a vault short of the refunds themselves stops the run.

import { admin, owner, printReserves, reserves, usd, withdraw } from './vault.ts';

const send = process.argv.includes('--send');
const { refunds } = await admin<{ refunds: { id: number; refundTo: string; amountMicros: string }[] }>(
  '/admin/refunds?status=pending',
);
const total = refunds.reduce((a, r) => a + BigInt(r.amountMicros), 0n);
console.log(`${refunds.length} pending refund(s), ${usd(total)} in total`);
for (const r of refunds) console.log(`  #${r.id} ${usd(r.amountMicros)} -> ${r.refundTo}`);
const before = await reserves();
printReserves(before);
if (!send || refunds.length === 0) {
  if (!send && refunds.length) console.log('dry run: add --send to pay them');
  process.exit(0);
}
if (before.vaultUsdgMicros !== null && BigInt(before.vaultUsdgMicros) < total) {
  throw new Error(`the vault holds ${usd(before.vaultUsdgMicros)}, less than the pending refunds: top it up first`);
}

const o = await owner();
for (const r of refunds) {
  const hash = await withdraw(o, r.refundTo, BigInt(r.amountMicros));
  await admin('/admin/refunds/paid', { id: r.id, txHash: hash });
  console.log(`paid #${r.id} ${usd(r.amountMicros)} -> ${r.refundTo}: ${hash}`);
}
