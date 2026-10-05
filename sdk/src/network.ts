// Where envolvr runs: Robinhood Chain mainnet, and the testnet.

export interface Network {
  /** OpenAI-compatible inference gateway (attested TDX VM). */
  gateway: string;
  /** Sign-in, account, pricing and receipt proofs. */
  control: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  /** USDG token (a test stand-in on testnet, with an open mint). */
  usdg: string;
  creditVault: string;
  receiptAnchor: string;
  /** This gateway's log in ReceiptAnchor: keccak256("envolvr.provider:<dstack app id>"). */
  providerId: string;
}

export const TESTNET: Network = {
  gateway: 'https://api.envolvr.xyz',
  control: 'https://auth.envolvr.xyz',
  chainId: 46630,
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com/rpc',
  explorer: 'https://explorer.testnet.chain.robinhood.com',
  usdg: '0xF7326a325aED45a1BF5D1268982f519BeCe941b6',
  creditVault: '0x2aaB804f3eB6B436CB542d56D171d020bC2d7c51',
  receiptAnchor: '0xff179938C830134D8E2922dAe7e16Ee4F0E33853',
  providerId: '0x86b99987cd8f8ebddc2dd0efa61ed52b5db594430f12446db424da0d9c4b831f',
};

/** The mainnet contract addresses are published at launch; until then they are this placeholder. */
export const PENDING_ADDRESS = '0x0000000000000000000000000000000000000000';

export const MAINNET: Network = {
  gateway: 'https://api.envolvr.xyz',
  control: 'https://auth.envolvr.xyz',
  chainId: 4663,
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robin.etherscan.io',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  creditVault: '0x24DbbBd7d5eE9674D8A8B19a492E87A4957B1261',
  receiptAnchor: '0x591fadf9d2D9d0A0fedEEd95d74321694797AF60',
  providerId: '0x86b99987cd8f8ebddc2dd0efa61ed52b5db594430f12446db424da0d9c4b831f',
};

/** Throws before any on-chain step on a network whose contracts are not published yet. */
export function assertContracts(network: Network): void {
  if ([network.usdg, network.creditVault].includes(PENDING_ADDRESS)) {
    throw new Error(`the contracts on chain ${network.chainId} are published at launch: see https://envolvr.xyz/token/#contracts`);
  }
}

/** USDG and envolvr balances have 6 decimals: "1.5" -> 1500000n. */
export function toMicros(amount: string | number): bigint {
  const s = String(amount).trim();
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(s);
  if (!m) throw new Error(`not a USD amount with at most 6 decimals: ${s}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

export function fromMicros(micros: bigint | string): string {
  const v = BigInt(micros);
  const sign = v < 0n ? '-' : '';
  const a = v < 0n ? -v : v;
  const frac = (a % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${a / 1_000_000n}${frac ? `.${frac}` : ''}`;
}
