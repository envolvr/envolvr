// Robinhood Chain testnet until mainnet. The same values as @envolvr/sdk's TESTNET.
import { defineChain } from 'viem';

/** The control plane. A page may name another one in <meta name="envolvr-control"> (local testing). */
export const CONTROL = document.querySelector('meta[name="envolvr-control"]')?.getAttribute('content') ?? 'https://auth.envolvr.xyz';

/** WalletConnect (Reown) project id: public, not a secret. Empty hides WalletConnect. */
export const WALLETCONNECT_PROJECT_ID = '';

export const chain = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com/rpc'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

export const contracts = {
  usdg: '0xF7326a325aED45a1BF5D1268982f519BeCe941b6',
  creditVault: '0x2aaB804f3eB6B436CB542d56D171d020bC2d7c51',
  envolvr: '0x4EbF132fe56ca80A467DCb5f64EcB30d82221b33',
  staking: '0xB14F681DD0589993750DE02C45132f40BC2e72Af',
} as const;

export const TESTNET = true;
