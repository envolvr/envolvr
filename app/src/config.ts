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
  blockExplorers: { default: { name: 'Etherscan', url: 'https://robin.etherscan.io' } },
});

// The same addresses as the site's data/network.json and the docs' contract table.
// NVLR and staking are not deployed yet (the staking card is hidden).
const PENDING = '0x0000000000000000000000000000000000000000';
export const contracts = {
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  creditVault: '0x24DbbBd7d5eE9674D8A8B19a492E87A4957B1261',
  nvlr: PENDING,
  staking: PENDING,
} as const;

/** Testnet adds the test USDG mint button. */
export const TESTNET = false;
