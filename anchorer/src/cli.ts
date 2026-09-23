// Build a receipt batch from receipt files and print the root and per-receipt
// proofs as JSON, ready for ReceiptAnchor.anchor and verifyReceipt.
//
//   node src/cli.ts batch <receipt.json>...

import { readFileSync } from 'node:fs';
import { buildBatch, proofFor, receiptDigest, verify } from './merkle.ts';

const [command, ...files] = process.argv.slice(2);
if (command !== 'batch' || files.length === 0) {
  console.error('usage: node src/cli.ts batch <receipt.json>...');
  process.exit(2);
}

const digests = files.map((f) => receiptDigest(JSON.parse(readFileSync(f, 'utf8'))));
const batch = buildBatch(digests);
const receipts = files.map((file, i) => {
  const proof = proofFor(batch, i);
  if (!verify(batch.root, digests[i], proof)) throw new Error(`self-check failed for ${file}`);
  return { file, digest: digests[i], proof };
});
console.log(JSON.stringify({ root: batch.root, count: files.length, receipts }, null, 2));
