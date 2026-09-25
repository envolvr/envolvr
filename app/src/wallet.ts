// Wallet connection: every browser wallet the page can see (EIP-6963, with
// window.ethereum as a fallback), and WalletConnect for mobile wallets, loaded
// only when chosen so the app contacts no third party otherwise.

import { chain, WALLETCONNECT_PROJECT_ID } from './config.ts';

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<any>;
  on?(event: string, listener: (...args: any[]) => void): void;
  disconnect?(): Promise<void>;
}

export interface WalletOption {
  id: string;
  name: string;
  icon?: string;
  connect(): Promise<Eip1193>;
}

interface Eip6963Detail { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 }

const announced = new Map<string, Eip6963Detail>();
window.addEventListener('eip6963:announceProvider', (e: Event) => {
  const d = (e as CustomEvent<Eip6963Detail>).detail;
  if (d?.info?.uuid) announced.set(d.info.uuid, d);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

/** The wallets to offer: announced browser wallets, window.ethereum, and WalletConnect when configured. */
export function walletOptions(): WalletOption[] {
  const options: WalletOption[] = [...announced.values()].map((d) => ({
    id: d.info.rdns || d.info.uuid, name: d.info.name, icon: d.info.icon, connect: async () => d.provider,
  }));
  const injected = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (options.length === 0 && injected) options.push({ id: 'injected', name: 'Browser wallet', connect: async () => injected });
  if (WALLETCONNECT_PROJECT_ID) {
    options.push({
      id: 'walletconnect', name: 'WalletConnect (mobile wallets)',
      connect: async () => {
        const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
        const provider = await EthereumProvider.init({
          projectId: WALLETCONNECT_PROJECT_ID,
          optionalChains: [chain.id],
          rpcMap: { [chain.id]: chain.rpcUrls.default.http[0] },
          showQrModal: true,
          metadata: {
            name: 'envolvr', description: 'Private inference your agent can prove',
            url: 'https://envolvr.xyz', icons: ['https://envolvr.xyz/favicon.svg'],
          },
        });
        await provider.connect();
        return provider as unknown as Eip1193;
      },
    });
  }
  return options;
}

/** Ask for accounts, then make sure the wallet is on Robinhood Chain (adding it if needed). */
export async function connect(option: WalletOption): Promise<{ provider: Eip1193; address: `0x${string}` }> {
  const provider = await option.connect();
  const [address] = await provider.request({ method: 'eth_requestAccounts' }) as `0x${string}`[];
  if (!address) throw new Error('the wallet shared no account');
  await ensureChain(provider);
  return { provider, address };
}

export async function ensureChain(provider: Eip1193): Promise<void> {
  const current = Number(await provider.request({ method: 'eth_chainId' }));
  if (current === chain.id) return;
  const hexId = `0x${chain.id.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
  } catch (err) {
    if ((err as { code?: number }).code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String((err as Error).message))) throw err;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hexId, chainName: chain.name, nativeCurrency: chain.nativeCurrency,
        rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: [chain.blockExplorers!.default.url],
      }],
    });
  }
}
