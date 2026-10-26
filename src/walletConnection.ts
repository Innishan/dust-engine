type InjectedProvider = {
  isCoinbaseWallet?: boolean;
  isMetaMask?: boolean;
  providers?: InjectedProvider[];
  request?: (...args: unknown[]) => unknown;
  on?: (...args: unknown[]) => unknown;
  removeListener?: (...args: unknown[]) => unknown;
};

export type WalletProviderWindow = {
  ethereum?: InjectedProvider;
  coinbaseWalletExtension?: InjectedProvider;
  matchMedia?: (query: string) => { matches: boolean };
};

export type WalletConnectorChoice = { id: string };

export function getCoinbaseInjectedProvider(walletWindow?: WalletProviderWindow) {
  if (!walletWindow) return undefined;
  if (walletWindow.coinbaseWalletExtension) return walletWindow.coinbaseWalletExtension;
  const ethereum = walletWindow.ethereum;
  if (ethereum?.isCoinbaseWallet) return ethereum;
  return ethereum?.providers?.find((provider) => provider.isCoinbaseWallet);
}

export function isCoinbaseMobileWalletContext(walletWindow?: WalletProviderWindow) {
  if (!walletWindow?.matchMedia?.("(pointer: coarse)").matches) return false;
  return Boolean(getCoinbaseInjectedProvider(walletWindow));
}

export function selectEmbeddedWalletConnector<T extends WalletConnectorChoice>(
  connectors: readonly T[],
  isFarcasterMiniApp: boolean,
  walletWindow?: WalletProviderWindow,
) {
  if (isFarcasterMiniApp) return connectors.find((connector) => connector.id === "farcaster");
  if (isCoinbaseMobileWalletContext(walletWindow)) {
    return connectors.find((connector) => connector.id === "coinbaseWallet");
  }
  return undefined;
}
