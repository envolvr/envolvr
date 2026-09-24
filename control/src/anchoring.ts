// Anchors receipt digests on Robinhood Chain (ReceiptAnchor).
//
// The gateway posts the digest of every signed receipt (POST /receipts). Time
// is cut into fixed slots of `intervalMs` (aligned to the Unix epoch); after a
// slot ends, the digests received before its end become one Merkle tree whose
// root is appended to this provider's log with ReceiptAnchor.anchor. An anchor
// therefore tells the chain only which slot a receipt fell in, never when in
// the slot its request ran, and slots without receipts anchor nothing. The
// transaction is signed with a key the dstack KMS derives for this app, so only
// this workload can append; the owner registers its address once with
// setAnchorer. GET /receipts/<digest>/proof then serves the inclusion proof.
//
// The chain is the source of truth. A batch is written to the ledger before its
// transaction is sent and marked anchored only when the contract holds its root
// at its index. Since anchor() takes the expected index, a resend can never
// anchor a batch twice. If the chain already holds a different root at an
// index (a ledger restored from an older backup), the local batch is dissolved
// and its digests go into the next one.

import { secp256k1 } from '@noble/curves/secp256k1';
import type { AnchorBatch, Store } from './db.ts';
import { dstackKey } from './dstack.ts';
import { addressOfKey, decodeWords, encodeCall, Rpc, signTx } from './evm.ts';
import { buildTree, proofFor, type Hex, type Tree } from './merkle.ts';

export const KMS_PATH = 'envolvr/control/receipt-anchorer';

/** The anchoring key: a secp256k1 key the dstack KMS derives for this app. */
export async function anchorKey(dstackEndpoint: string): Promise<Uint8Array> {
  const key = new Uint8Array(await dstackKey(dstackEndpoint, KMS_PATH, 'signing'));
  if (!secp256k1.utils.isValidPrivateKey(key)) throw new Error('dstack key is not a valid secp256k1 key');
  return key;
}

export interface OnChainBatch {
  root: string;
  anchoredAt: number;
}

/** What the anchorer needs from ReceiptAnchor. */
export interface AnchorChain {
  readonly address: string;
  anchorer(): Promise<string>;
  batchCount(): Promise<number>;
  batch(index: number): Promise<OnChainBatch>;
  /** Send anchor(); returns the transaction hash. */
  send(index: number, root: string, count: number): Promise<string>;
  /** null while pending or unknown. */
  receipt(txHash: string): Promise<{ success: boolean; blockNumber: number } | null>;
  balance(): Promise<bigint>;
}

export class ReceiptAnchorContract implements AnchorChain {
  readonly address: string;
  private rpc: Rpc;
  private contract: string;
  private providerId: string;
  private chainId: bigint;
  private key: Uint8Array;

  constructor(opts: { rpc: Rpc; contract: string; providerId: string; chainId: number; key: Uint8Array }) {
    this.rpc = opts.rpc;
    this.contract = opts.contract;
    this.providerId = opts.providerId;
    this.chainId = BigInt(opts.chainId);
    this.key = opts.key;
    this.address = addressOfKey(opts.key);
  }

  private async view(signature: string, args: (bigint | string)[]): Promise<string[]> {
    const data = encodeCall(signature, args);
    return decodeWords(await this.rpc.call<string>('eth_call', [{ to: this.contract, data }, 'latest']));
  }

  async anchorer(): Promise<string> {
    return `0x${(await this.view('anchorerOf(bytes32)', [this.providerId]))[0].slice(-40)}`;
  }

  async batchCount(): Promise<number> {
    return Number(BigInt((await this.view('batchCount(bytes32)', [this.providerId]))[0]));
  }

  async batch(index: number): Promise<OnChainBatch> {
    const [root, , , anchoredAt] = await this.view('batch(bytes32,uint256)', [this.providerId, BigInt(index)]);
    return { root, anchoredAt: Number(BigInt(anchoredAt)) };
  }

  async send(index: number, root: string, count: number): Promise<string> {
    const chainId = BigInt(await this.rpc.call<string>('eth_chainId', []));
    if (chainId !== this.chainId) throw new Error(`RPC is on chain ${chainId}, expected ${this.chainId}`);
    const data = encodeCall('anchor(bytes32,uint256,bytes32,uint32)', [this.providerId, BigInt(index), root, BigInt(count)]);
    const call = { from: this.address, to: this.contract, data };
    const [nonce, gas, block] = await Promise.all([
      this.rpc.call<string>('eth_getTransactionCount', [this.address, 'latest']),
      this.rpc.call<string>('eth_estimateGas', [call]),
      this.rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]),
    ]);
    const priority = await this.rpc.call<string>('eth_maxPriorityFeePerGas', []).then(BigInt, () => 0n);
    const baseFee = BigInt(block.baseFeePerGas ?? (await this.rpc.call<string>('eth_gasPrice', [])));
    const { raw, hash } = signTx({
      chainId, nonce: BigInt(nonce), maxPriorityFeePerGas: priority, maxFeePerGas: baseFee * 2n + priority,
      gas: (BigInt(gas) * 13n) / 10n, to: this.contract, value: 0n, data,
    }, this.key);
    const sent = await this.rpc.call<string>('eth_sendRawTransaction', [raw]);
    if (sent.toLowerCase() !== hash) throw new Error(`node returned tx hash ${sent}, expected ${hash}`);
    return hash;
  }

  async receipt(txHash: string) {
    const r = await this.rpc.call<{ status: string; blockNumber: string } | null>('eth_getTransactionReceipt', [txHash]);
    return r && { success: BigInt(r.status) === 1n, blockNumber: Number(BigInt(r.blockNumber)) };
  }

  async balance(): Promise<bigint> {
    return BigInt(await this.rpc.call<string>('eth_getBalance', [this.address, 'latest']));
  }
}

type Log = (msg: string, fields?: Record<string, unknown>) => void;

export type TickResult = 'idle' | 'waiting' | 'anchored' | 'sent' | 'dissolved';

export interface AnchorerOptions {
  /** Slot length: one batch per slot at most. */
  intervalMs: number;
  /** How long to wait for a sent transaction before sending it again. */
  resendAfterMs: number;
  /** How long one tick waits for a receipt after sending. */
  confirmWaitMs: number;
  maxBatch: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: Log;
}

export class Anchorer {
  private store: Store;
  private chain: AnchorChain;
  private opts: AnchorerOptions;

  constructor(store: Store, chain: AnchorChain, opts: Partial<AnchorerOptions> = {}) {
    this.store = store;
    this.chain = chain;
    this.opts = {
      intervalMs: opts.intervalMs ?? 600_000,
      resendAfterMs: opts.resendAfterMs ?? 120_000,
      confirmWaitMs: opts.confirmWaitMs ?? 60_000,
      maxBatch: opts.maxBatch ?? 100_000,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      log: opts.log ?? (() => {}),
    };
  }

  /**
   * One step: settle the open batch if there is one, otherwise cut this slot's
   * batch from the digests received before the slot began. Returns what
   * happened, for logs and tests.
   */
  async tick(): Promise<TickResult> {
    const chainCount = await this.chain.batchCount();
    const open = this.store.openBatch();
    if (open) return this.settle(open, chainCount);

    const last = this.store.lastBatch();
    const slotStart = Math.floor(this.opts.now() / this.opts.intervalMs) * this.opts.intervalMs;
    if (last && last.createdAt * 1000 >= slotStart) return 'idle';
    const digests = this.store.unbatchedDigests(this.opts.maxBatch, Math.floor(slotStart / 1000));
    if (digests.length === 0) return 'idle';
    const index = Math.max(chainCount, last ? last.batchIndex + 1 : 0);
    const tree = buildTree(digests);
    this.store.createBatch(index, tree.root, digests, Math.floor(this.opts.now() / 1000));
    return this.sendAndConfirm(this.store.batch(index)!);
  }

  private async settle(open: AnchorBatch, chainCount: number): Promise<TickResult> {
    if (open.batchIndex < chainCount) {
      const onChain = await this.chain.batch(open.batchIndex);
      if (onChain.root.toLowerCase() === open.root.toLowerCase()) {
        const blockNumber = open.txHash ? (await this.chain.receipt(open.txHash))?.blockNumber ?? null : null;
        this.store.batchAnchored(open.batchIndex, onChain.anchoredAt, blockNumber);
        this.opts.log('receipt batch anchored', { batch: open.batchIndex, count: open.count, tx: open.txHash });
        return 'anchored';
      }
      this.store.dissolveBatch(open.batchIndex);
      this.opts.log('receipt batch index already used on chain; digests requeued', { batch: open.batchIndex });
      return 'dissolved';
    }
    if (open.batchIndex > chainCount) {
      // The chain is behind our ledger (earlier batches missing there): start over at its count.
      this.store.dissolveBatch(open.batchIndex);
      this.opts.log('receipt batch ahead of the chain; digests requeued', { batch: open.batchIndex, chainCount });
      return 'dissolved';
    }
    if (open.txHash && open.sentAt !== null) {
      const receipt = await this.chain.receipt(open.txHash);
      const waited = this.opts.now() - open.sentAt * 1000;
      if (!receipt && waited < this.opts.resendAfterMs) return 'waiting';
      if (receipt?.success) return 'waiting'; // mined, but the view has not caught up yet
    }
    return this.sendAndConfirm(open);
  }

  private async sendAndConfirm(batch: AnchorBatch): Promise<TickResult> {
    const txHash = await this.chain.send(batch.batchIndex, batch.root, batch.count);
    this.store.batchSent(batch.batchIndex, txHash, Math.floor(this.opts.now() / 1000));
    this.opts.log('receipt batch sent', { batch: batch.batchIndex, count: batch.count, tx: txHash });
    const deadline = this.opts.now() + this.opts.confirmWaitMs;
    while (this.opts.now() < deadline) {
      await this.opts.sleep(2_000);
      const receipt = await this.chain.receipt(txHash);
      if (!receipt) continue;
      if (!receipt.success) {
        this.opts.log('receipt batch transaction reverted', { batch: batch.batchIndex, tx: txHash });
        return 'sent';
      }
      const result: TickResult = await this.settle(this.store.batch(batch.batchIndex)!, await this.chain.batchCount());
      return result === 'anchored' ? 'anchored' : 'sent';
    }
    return 'sent';
  }

  /** Tick every `pollMs` until stopped. */
  start(pollMs: number): () => void {
    let stopped = false;
    const loop = async () => {
      try {
        const address = await this.chain.anchorer();
        if (address.toLowerCase() !== this.chain.address.toLowerCase()) {
          this.opts.log('receipt anchoring key is not registered: the owner must call setAnchorer', {
            anchorer: this.chain.address, registered: address,
          });
        }
        this.opts.log('receipt anchoring started', { anchorer: this.chain.address, balanceWei: String(await this.chain.balance()) });
      } catch (err) {
        this.opts.log('receipt anchoring check failed', { error: String(err) });
      }
      while (!stopped) {
        try {
          const result = await this.tick();
          if (result === 'anchored') this.opts.log('receipt anchoring balance', { balanceWei: String(await this.chain.balance()) });
        } catch (err) {
          this.opts.log('receipt anchoring failed', { error: String(err) });
        }
        await this.opts.sleep(pollMs);
      }
    };
    void loop();
    return () => { stopped = true; };
  }
}

export interface ReceiptProof {
  status: 'anchored' | 'pending';
  digest: string;
  batchIndex?: number;
  leafIndex?: number;
  count?: number;
  root?: string;
  proof?: Hex[];
  txHash?: string | null;
  blockNumber?: number | null;
  anchoredAt?: number;
}

/** Inclusion proofs, with the last few trees kept in memory. */
export class ProofService {
  private store: Store;
  private trees = new Map<number, Tree>();

  constructor(store: Store) {
    this.store = store;
  }

  proof(digest: string): ReceiptProof | undefined {
    const at = this.store.receiptDigest(digest);
    if (!at) return undefined;
    const batch = at.batchIndex === null ? undefined : this.store.batch(at.batchIndex);
    if (!batch || batch.anchoredAt === null || at.leafIndex === null) return { status: 'pending', digest };
    let tree = this.trees.get(batch.batchIndex);
    if (!tree) {
      tree = buildTree(this.store.batchDigests(batch.batchIndex));
      if (tree.root !== batch.root.toLowerCase()) throw new Error(`batch ${batch.batchIndex} does not rebuild to its root`);
      this.trees.set(batch.batchIndex, tree);
      if (this.trees.size > 8) this.trees.delete(this.trees.keys().next().value!);
    }
    return {
      status: 'anchored', digest, batchIndex: batch.batchIndex, leafIndex: at.leafIndex, count: batch.count,
      root: batch.root, proof: proofFor(tree, at.leafIndex), txHash: batch.txHash, blockNumber: batch.blockNumber,
      anchoredAt: batch.anchoredAt,
    };
  }
}
