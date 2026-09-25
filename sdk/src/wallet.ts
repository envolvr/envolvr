// Wallets. envolvr needs a wallet for two things: signing the sign-in message
// (EIP-191) and, to deposit USDG, sending two transactions. Bring your own by
// implementing Signer (for example around viem or ethers), or use
// privateKeySigner for a plain key.

import { hexToBytes } from '@noble/hashes/utils';
import { addressOfKey, personalSign, Rpc, signTx } from './evm.ts';

export interface Signer {
  address: string;
  /** EIP-191 personal_sign of a UTF-8 message: 65 bytes as 0x hex. */
  signMessage(message: string): Promise<string>;
  /** Send a transaction and resolve once it is mined; returns its hash. Needed for deposits only. */
  sendTransaction?(tx: { to: string; data: string }): Promise<string>;
}

export function privateKeySigner(privateKey: string, opts: { rpcUrl: string; chainId: number }): Signer {
  const key = hexToBytes(privateKey.replace(/^0x/, ''));
  if (key.length !== 32) throw new Error('a private key is 32 bytes of hex');
  const address = addressOfKey(key);
  const rpc = new Rpc(opts.rpcUrl);
  return {
    address,
    async signMessage(message) {
      return personalSign(message, key);
    },
    async sendTransaction({ to, data }) {
      const chainId = BigInt(await rpc.call<string>('eth_chainId', []));
      if (chainId !== BigInt(opts.chainId)) throw new Error(`RPC is on chain ${chainId}, expected ${opts.chainId}`);
      const call = { from: address, to, data };
      const [nonce, gas, block] = await Promise.all([
        rpc.call<string>('eth_getTransactionCount', [address, 'pending']),
        rpc.call<string>('eth_estimateGas', [call]),
        rpc.call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]),
      ]);
      const priority = await rpc.call<string>('eth_maxPriorityFeePerGas', []).then(BigInt, () => 0n);
      const baseFee = BigInt(block.baseFeePerGas ?? (await rpc.call<string>('eth_gasPrice', [])));
      const { raw, hash } = signTx({
        chainId, nonce: BigInt(nonce), maxPriorityFeePerGas: priority, maxFeePerGas: baseFee * 2n + priority,
        gas: (BigInt(gas) * 13n) / 10n, to, value: 0n, data,
      }, key);
      await rpc.call<string>('eth_sendRawTransaction', [raw]);
      for (let i = 0; i < 90; i++) {
        const r = await rpc.call<{ status: string } | null>('eth_getTransactionReceipt', [hash]);
        if (r) {
          if (BigInt(r.status) !== 1n) throw new Error(`transaction ${hash} reverted`);
          return hash;
        }
        await new Promise((res) => setTimeout(res, 2_000));
      }
      throw new Error(`transaction ${hash} not mined after 3 minutes`);
    },
  };
}
