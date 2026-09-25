// node src/cli.ts batch <receipt.json>...
//   Build a receipt batch from receipt files and print the root and per-receipt
//   proofs as JSON, ready for ReceiptAnchor.anchor and verifyReceipt.
//
// node src/cli.ts verify <receipt.json> [--proof-service URL] [--rpc URL]
//                        [--contract ADDRESS] [--provider BYTES32] [--chain-id N]
//   Check that a receipt is anchored on Robinhood Chain: digest computed here,
//   proof checked locally and by the contract itself. Defaults: envolvr's
//   production gateway, from contracts/deployments/robinhood-testnet.json.
//   Exit 0 anchored, 2 pending or unknown, 1 failed.

import { readFileSync } from 'node:fs';
import { buildBatch, proofFor, receiptDigest, verify } from './merkle.ts';
import { verifyAnchored } from './verify.ts';

const [command, ...args] = process.argv.slice(2);

if (command === 'batch' && args.length > 0) {
  const digests = args.map((f) => receiptDigest(JSON.parse(readFileSync(f, 'utf8'))));
  const batch = buildBatch(digests);
  const receipts = args.map((file, i) => {
    const proof = proofFor(batch, i);
    if (!verify(batch.root, digests[i], proof)) throw new Error(`self-check failed for ${file}`);
    return { file, digest: digests[i], proof };
  });
  console.log(JSON.stringify({ root: batch.root, count: args.length, receipts }, null, 2));
} else if (command === 'verify' && args[0] && !args[0].startsWith('--')) {
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i > 0 ? args[i + 1] : undefined;
  };
  const deployment = JSON.parse(readFileSync(new URL('../../contracts/deployments/robinhood-testnet.json', import.meta.url), 'utf8'));
  const production = deployment.anchoring.find((a: { providerLabel: string }) => a.providerLabel.includes('envolvr-prod'));
  const target = {
    proofService: flag('proof-service') ?? 'https://auth.envolvr.xyz',
    rpcUrl: flag('rpc') ?? deployment.rpc,
    chainId: Number(flag('chain-id') ?? deployment.chainId),
    contract: flag('contract') ?? deployment.contracts.ReceiptAnchor,
    providerId: flag('provider') ?? production.providerId,
  };
  try {
    const r = await verifyAnchored(JSON.parse(readFileSync(args[0], 'utf8')), target);
    if (r.status !== 'anchored') {
      console.log(`${r.status.toUpperCase()}  ${r.digest}`);
      console.log(r.status === 'pending'
        ? 'Known to the proof service, not anchored yet: batches close every 10 minutes (UTC).'
        : 'The proof service does not know this receipt digest.');
      process.exit(2);
    }
    console.log(`ANCHORED  ${r.digest}`);
    console.log(`  batch ${r.batchIndex}, leaf ${r.leafIndex} of ${r.count}, root ${r.root}`);
    console.log(`  anchored ${new Date(r.anchoredAt! * 1000).toISOString()} in tx ${r.txHash ?? '(unknown)'}`);
    console.log(`  checked on chain ${target.chainId}: ReceiptAnchor ${target.contract}, provider ${target.providerId}`);
  } catch (err) {
    console.error(`FAILED  ${(err as Error).message}`);
    process.exit(1);
  }
} else {
  console.error('usage: node src/cli.ts batch <receipt.json>...\n       node src/cli.ts verify <receipt.json> [--proof-service URL] [--rpc URL] [--contract ADDRESS] [--provider BYTES32] [--chain-id N]');
  process.exit(2);
}
