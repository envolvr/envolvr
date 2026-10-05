// Robinhood Chain mainnet. The same values as @envolvr/sdk's MAINNET.
import { defineChain } from 'viem';

/** The control plane. A page may name another one in <meta name="envolvr-control"> (local testing). */
export const CONTROL = document.querySelector('meta[name="envolvr-control"]')?.getAttribute('content') ?? 'https://auth.envolvr.xyz';

/** WalletConnect (Reown) project id: public, not a secret. Empty hides WalletConnect. */
export const WALLETCONNECT_PROJECT_ID = '973fa1356cbee48ff81102e84d7b9a60';

export const chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

// LAUNCH: fill in the mainnet addresses (also the site's data/network.json and the docs' contract table).
const PENDING = '0x0000000000000000000000000000000000000000';
export const contracts = {
  usdg: PENDING,
  creditVault: PENDING,
  nvlr: PENDING,
  staking: PENDING,
} as const;

/** Testnet adds the test USDG mint button. */
export const TESTNET = false;
