import {
  ChainType,
  EVM,
  config as lifiConfig,
  convertExtendedChain,
  createConfig,
  getChains,
  getConnections,
  getTokens,
  type BasicConnection,
  type ExtendedChain,
  type Token,
} from "@lifi/sdk";
import {
  createClient,
  createPublicClient,
  custom,
  encodeFunctionData,
  http,
  numberToHex,
  zeroAddress,
  type Address,
  type Client,
} from "viem";

export const BRIDGE_INTEGRATOR = "dustengine";
export const BRIDGE_FEE = 0.0025;

type Eip1193Provider = {
  request: (request: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type BridgeConnector = {
  getChainId: () => Promise<number>;
  getProvider: (parameters?: { chainId?: number }) => Promise<unknown>;
};

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

let isConfigured = false;

function ensureBridgeLiFiConfig() {
  if (isConfigured) {
    return;
  }

  const apiKey = import.meta.env.VITE_LIFI_API_KEY;

  createConfig({
    // The LI.FI SDK config is shared with Clean Dust. Keep its established
    // default integrator here; Bridge supplies its integrator per route.
    integrator: "lifi-sdk",
    ...(apiKey ? { apiKey } : {}),
    preloadChains: false,
    disableVersionCheck: true,
  });
  isConfigured = true;
}

function getChain(chains: ExtendedChain[], chainId: number) {
  const chain = chains.find((candidate) => candidate.id === chainId);
  if (!chain) {
    throw new Error("The selected network is no longer supported by LI.FI.");
  }
  return chain;
}

async function getProvider(connector: BridgeConnector, chainId: number) {
  const provider = await connector.getProvider({ chainId });
  if (!provider || typeof (provider as Eip1193Provider).request !== "function") {
    throw new Error("The connected wallet does not provide an EVM transaction provider.");
  }
  return provider as Eip1193Provider;
}

async function createConnectorWalletClient(
  connector: BridgeConnector,
  address: Address,
  chains: ExtendedChain[],
  chainId: number,
): Promise<Client> {
  const chain = getChain(chains, chainId);
  const provider = await getProvider(connector, chainId);

  // LI.FI SDK v3 expects a base viem Client. Its EIP-1193 transport and
  // connected account still make this client a signer for wallet actions.
  return createClient({
    account: address,
    chain: convertExtendedChain(chain),
    transport: custom(provider),
  });
}

export function configureBridgeEvmProvider({
  address,
  connector,
  chains,
}: {
  address: Address;
  connector: BridgeConnector;
  chains: ExtendedChain[];
}) {
  ensureBridgeLiFiConfig();

  lifiConfig.setProviders([
    EVM({
      getWalletClient: async () => {
        const chainId = await connector.getChainId();
        return createConnectorWalletClient(connector, address, chains, chainId);
      },
      switchChain: async (chainId) => {
        const chain = getChain(chains, chainId);
        const provider = await getProvider(connector, chainId);

        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: numberToHex(chain.id) }],
          });
        } catch (error) {
          const code = (error as { code?: number })?.code;
          if (code !== 4902) {
            throw error;
          }

          await provider.request({
            method: "wallet_addEthereumChain",
            params: [{ ...chain.metamask, chainId: numberToHex(chain.id) }],
          });
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: numberToHex(chain.id) }],
          });
        }

        return createConnectorWalletClient(connector, address, chains, chainId);
      },
    }),
  ]);
}

export async function getSupportedEvmChains(): Promise<ExtendedChain[]> {
  ensureBridgeLiFiConfig();

  const chains = await getChains({
    chainTypes: [ChainType.EVM],
  });

  // preloadChains is intentionally disabled, so keep the SDK's
  // internal chain registry synchronized with the dynamic LI.FI list.
  lifiConfig.setChains(chains);

  return chains;
}

export async function getSupportedTokens(
  chainId: number,
  search?: string,
): Promise<Token[]> {
  ensureBridgeLiFiConfig();

  const response = await getTokens({
    chains: [chainId],
    extended: true,
    limit: 100,
    search: search || undefined,
  });

  return response.tokens[chainId] ?? [];
}

export async function getSupportedConnections(
  fromChainId: number,
  toChainId: number,
): Promise<BasicConnection[]> {
  ensureBridgeLiFiConfig();
  const response = await getConnections({
    fromChain: fromChainId,
    toChain: toChainId,
    chainTypes: [ChainType.EVM],
  });
  return response.connections;
}

export async function getBridgeTokenBalance({
  address,
  chainId,
  chains,
  token,
}: {
  address: Address;
  chainId: number;
  chains: ExtendedChain[];
  token: Token;
}): Promise<bigint> {
  if (token.chainId !== chainId) {
    throw new Error("The selected token does not belong to the source network.");
  }

  const chain = getChain(chains, chainId);
  const rpcUrl = chain.metamask?.rpcUrls?.[0];
  if (!rpcUrl) {
    throw new Error("LI.FI did not provide an RPC URL for the selected source network.");
  }

  const client = createPublicClient({
    chain: convertExtendedChain(chain),
    transport: http(rpcUrl),
  });

  if (token.address.toLowerCase() === zeroAddress) {
    return client.getBalance({ address });
  }

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{
        to: token.address,
        data: encodeFunctionData({
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [address],
        }),
      }, "latest"],
    }),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error("Unable to read the ERC-20 balance on the source network.");
  }
  const result = (payload as Record<string, unknown>).result;
  if (typeof result !== "string" || !/^0x[\da-fA-F]+$/.test(result)) {
    throw new Error("The source network returned an invalid ERC-20 balance.");
  }
  return BigInt(result);
}
