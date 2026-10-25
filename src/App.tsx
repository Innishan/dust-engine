import {
  createConfig,
  http,
  WagmiProvider,
  useAccount,
  useConnect,
  useDisconnect,
  useBalance,
  useWriteContract,
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useSendTransaction,
  useSignTypedData,
  useSignMessage,
} from "wagmi";
import { base } from "wagmi/chains";
import { injected, coinbaseWallet } from "wagmi/connectors";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";
import {
  ConnectKitProvider,
  getDefaultConfig,
  ConnectKitButton,
  useModal,
} from "connectkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type MutableRefObject, type MouseEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Settings,
  RefreshCw,
  Trash2,
  CheckCircle2,
  Trophy,
  AlertCircle,
  ExternalLink,
  Coins,
  ArrowRight,
  Zap,
  Hammer,
  Wrench,
  Search,
  Twitter,
  Menu,
  X,
  Users,
} from "lucide-react";
import {
  formatUnits,
  createPublicClient,
  decodeEventLog,
  getAddress,
  isAddress,
  parseUnits,
  encodeFunctionData,
  getContract,
  type Address,
  maxUint256,
  keccak256,
  toBytes,
} from "viem";
import { PERMIT2_ADDRESS } from "@uniswap/permit2-sdk";
import axios from "axios";
import { DUST_ENGINE_ADDRESS, DUST_ENGINE_ABI } from "./contracts/dustEngine";
import { DUST_GENESIS_ABI } from "./contracts/dustGenesis";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { getRoutes, getStepTransaction } from "@lifi/sdk";
import { sdk } from "@farcaster/miniapp-sdk";
import { BridgePanel } from "./bridge/BridgePanel";
import { mergeTokenLogoURI, resolveTokenLogoURI, TokenLogo, tokenLogoKey, usableTokenLogoUrl } from "./tokenLogo";
import { getSupportedTokenLogoMap } from "./bridge/lifi";
import AchievementsPanel from "./achievements/AchievementsPanel";
import AmbassadorPanel from "./ambassador/AmbassadorPanel";
import LegalPages from "./LegalPages";
import { createScanRunGuard, withConsoleTimer } from "./scanLifecycle";
import {
  isTransientBalanceReadError,
  MAX_INDIVIDUAL_BALANCE_RETRIES_PER_SCAN,
  recordSuccessfulBalances,
  retryFailedBalanceReads,
  verifiedPositiveBalances,
} from "./scanBalanceVerification";
import {
  createInitialQuotes,
  fetchDexScreenerQuotes,
  indicativePriceAddresses,
  manualTokenPriceQuote,
  MIN_DEX_TRADES_24H,
  MIN_DEX_VOLUME_24H_USD,
  MIN_TRUSTED_LIQUIDITY_USD,
  potentialMarketEvidenceAddresses,
  qualifyingMarketEvidencePools,
  type BlockscoutQuote,
  type PriceQuote,
} from "./tokenPricing";
import { evaluateCleanDustEligibility } from "./tokenEligibility";
import {
  acquireGeckoRequestSlot,
  acquireGoPlusRequestSlot,
  fetchGeckoMarketEvidenceDetailed,
  marketEvidencePoolKey,
  fetchGoPlusRisk,
  marketEvidenceCache,
  MARKET_EVIDENCE_LIMIT,
  summarizeGoPlusDiagnostics,
  type PoolIdentity,
} from "./marketEvidence";
import { diagnoseCleanDustScan, diagnoseDustToken, isDetectedDust, isInitiallySelectedDust } from "./cleanDustDetection";
import { diagnoseRouteQuote } from "./executionQuote";
import { createProviderRequestMetrics, measureProviderRequest, roundedDurationMs } from "./scanDiagnostics";
import { getWalletErrorDetails, logWalletDiagnostic, type WalletDiagnosticState } from "./walletDiagnostics";

const farcasterDiagnosticProviders = new WeakMap<object, object>();
const walletConfigIds = new WeakMap<object, string>();
let nextWalletConfigId = 1;
function walletConfigIdentity(config: object) {
  let identity = walletConfigIds.get(config);
  if (!identity) {
    identity = `wagmi-config-${nextWalletConfigId++}`;
    walletConfigIds.set(config, identity);
  }
  return identity;
}

function logFarcasterRpcDiagnostic(level: "debug" | "error", details: unknown) {
  try {
    console[level]("[DustEngine][Farcaster RPC]", typeof details === "function" ? details() : details);
  } catch {
    // Diagnostic logging must never affect provider results or errors.
  }
}

function sanitizeRpcErrorValue(value: unknown, key = "", depth = 0): unknown {
  if (/calldata|\binput\b|signature|private.?key|seed|mnemonic|credential|authorization/i.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    if (/^0x[\da-f]{66,}$/i.test(value)) return "[redacted hex payload]";
    return value.slice(0, 500);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "[nested value omitted]";
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeRpcErrorValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
    return Object.fromEntries(entries.map(([childKey, childValue]) => [
      childKey,
      sanitizeRpcErrorValue(childValue, childKey, depth + 1),
    ]));
  }
  return String(value);
}

function getRpcErrorDiagnostics(error: unknown) {
  const readFields = (value: unknown) => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return {};
    const record = value as Record<string, unknown>;
    return {
      ...(record.code !== undefined ? { code: sanitizeRpcErrorValue(record.code) } : {}),
      ...(record.message !== undefined ? { message: sanitizeRpcErrorValue(record.message) } : {}),
      ...(record.details !== undefined ? { details: sanitizeRpcErrorValue(record.details) } : {}),
      ...(record.data !== undefined ? { data: sanitizeRpcErrorValue(record.data, "errorData") } : {}),
    };
  };
  const topLevel = readFields(error);
  const cause = error && (typeof error === "object" || typeof error === "function")
    ? (error as { cause?: unknown }).cause
    : undefined;
  return {
    ...topLevel,
    ...(cause !== undefined ? { cause: readFields(cause) } : {}),
  };
}

function getExplicitRpcChainContext(
  method: string,
  params: unknown,
): Record<string, string | number | Array<string | number>> {
  const context: Record<string, string | number | Array<string | number>> = {};
  if (!Array.isArray(params)) return context;
  if (method === "wallet_getCapabilities" && Array.isArray(params[1])) {
    const chainIds = params[1].filter((value): value is string | number =>
      typeof value === "string" || typeof value === "number",
    );
    if (chainIds.length) context.chainIds = chainIds;
  }
  for (const param of params) {
    if (!param || typeof param !== "object") continue;
    const record = param as Record<string, unknown>;
    const chainId = record.chainId ?? record.chain_id;
    if (typeof chainId === "string" || typeof chainId === "number") context.chainId = chainId;
    const chainIds = record.chainIds ?? record.chain_ids;
    if (Array.isArray(chainIds)) {
      const safeChainIds = chainIds.filter((value): value is string | number =>
        typeof value === "string" || typeof value === "number",
      );
      if (safeChainIds.length) context.chainIds = safeChainIds;
    }
  }
  return context;
}

function withFarcasterRpcDiagnostics(provider: unknown) {
  if (!import.meta.env.DEV || !provider || typeof provider !== "object") return provider;
  const cachedProvider = farcasterDiagnosticProviders.get(provider);
  if (cachedProvider) return cachedProvider;

  const diagnosticProvider = new Proxy(provider, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (property !== "request" || typeof original !== "function") return original;

      return async (args: { method: string; params?: unknown }) => {
        const method = typeof args?.method === "string" ? args.method : "<unknown>";
        const context = {
          method,
          ...getExplicitRpcChainContext(method, args?.params),
          transactionSubmission: /^(eth_sendTransaction|wallet_sendTransaction|wallet_sendCalls|wallet_sendCallsAsync|eth_sendRawTransaction)$/i.test(method),
          chainSwitch: /^(wallet_switchEthereumChain|wallet_addEthereumChain)$/i.test(method),
          gasEstimation: /estimateGas/i.test(method),
        };

        try {
          const result = await Reflect.apply(original, target, [args]);
          const isTransactionSubmission = context.transactionSubmission;
          const returnsTransactionHash = /^(eth_sendTransaction|wallet_sendTransaction|eth_sendRawTransaction)$/i.test(method);
          const transactionHash = returnsTransactionHash && typeof result === "string" && /^0x[\da-f]{64}$/i.test(result)
            ? result
            : undefined;
          logFarcasterRpcDiagnostic("debug", {
            ...context,
            success: true,
            ...(returnsTransactionHash ? {
              transactionHashReturned: transactionHash !== undefined,
              ...(transactionHash ? { transactionHash } : {}),
            } : {}),
          });
          return result;
        } catch (error) {
          logFarcasterRpcDiagnostic("error", () => ({
            ...context,
            success: false,
            error: getRpcErrorDiagnostics(error),
          }));
          throw error;
        }
      };
    },
  }) as object;

  farcasterDiagnosticProviders.set(provider, diagnosticProvider);
  return diagnosticProvider;
}

function farcasterMiniAppWithDiagnostics() {
  const createFarcasterConnector = farcasterMiniApp();
  return (config: Parameters<typeof createFarcasterConnector>[0]) => {
    const connector = createFarcasterConnector(config);
    const getProvider = connector.getProvider.bind(connector);
    connector.getProvider = async (...args) =>
      withFarcasterRpcDiagnostics(await getProvider(...args)) as Awaited<ReturnType<typeof getProvider>>;
    return connector;
  };
}

sdk.actions.ready();

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Constants ---
const ONE_INCH_ROUTER = "0x111111125421ca6dc452d289314280a0f8842a65" as Address;
const PROTOCOL_FEE_RECIPIENT =
  "0xEe36C3c644240302eB8121F66D4e23C068512a40" as Address; // Fee collector
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const LOCAL_KNOWN_PRICES: Record<string, number> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 1,
  "0xfde4c96c8593536e31f229ea8f37b2ad3d69d441": 1,
  "0x50c5725949a6f0c72e6c45641830677285586337": 1,
  "0x4200000000000000000000000000000000000006": 2500,
};

const COMMON_BASE_TOKENS = [
  {
    symbol: "USDC",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
    decimals: 6,
  },
  {
    symbol: "USDT",
    address: "0xfde4C96c8593536E31F229EA8f37b2AD3d69d441" as Address,
    decimals: 6,
  },
  {
    symbol: "DAI",
    address: "0x50c5725949A6F0C72E6C45641830677285586337" as Address,
    decimals: 18,
  },
  {
    symbol: "WETH",
    address: "0x4200000000000000000000000000000000000006" as Address,
    decimals: 18,
  },
];

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

const PERMIT2_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

const PERMIT2_SIGNATURE_ABI = [
  {
    name: "nonceBitmap",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "wordPos", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const queryClient = new QueryClient();

// --- Components ---

const Gear = ({
  className,
  speed = 10,
  reverse = false,
}: {
  className?: string;
  speed?: number;
  reverse?: boolean;
}) => (
  <motion.div
    animate={{ rotate: reverse ? -360 : 360 }}
    transition={{ duration: speed, repeat: Infinity, ease: "linear" }}
    className={cn("text-zinc-600", className)}
  >
    <Settings size={40} strokeWidth={1.5} />
  </motion.div>
);

interface TokenInfo {
  symbol: string;
  address: Address;
  logoURI?: string;
  decimals: number;
  balance: bigint;
  formattedBalance: string;
  priceUsd: number;
  valueUsd: number;
  priceAcceptedForDust: boolean;
  /** Legacy compatibility alias for scan-price admission, not route verification. */
  isVerified: boolean;
  isEligible: boolean;
  eligibilityReason?: string;
  priceSource?: string;
  priceEvidenceStatus: "locally_configured" | "market_corroborated" | "indicative" | "unavailable";
  selected: boolean;
}

function resolveErc20Metadata(
  decimalsResult: { status?: string; result?: unknown } | undefined,
  symbolResult: { status?: string; result?: unknown } | undefined,
): { decimals: number; symbol: string } | undefined {
  const decimals = Number(decimalsResult?.result);
  if (decimalsResult?.status !== "success" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return undefined;
  }
  return {
    decimals,
    symbol: symbolResult?.status === "success" && typeof symbolResult.result === "string" && symbolResult.result
      ? symbolResult.result
      : "???",
  };
}

function metadataErrorCategory(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const details = current as { name?: unknown; message?: unknown; shortMessage?: unknown; code?: unknown; status?: unknown; cause?: unknown };
    messages.push(...[details.name, details.shortMessage, details.message, details.code, details.status]
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map(String));
    current = details.cause;
  }
  const message = messages.join(" ").toLowerCase();
  if (/429|rate.limit/.test(message)) return "rate_limited";
  if (/timeout|timed out|abort/.test(message)) return "timeout";
  if (/http|fetch|network|transport/.test(message)) return "transport_failure";
  return "multicall_failure";
}

type ProductSection = "clean" | "bridge" | "liquidity" | "lend" | "achievements" | "ambassador";

export default function App() {
  const pathname = window.location.pathname;

  if (pathname === "/terms") {
    return <LegalPages type="terms" />;
  }

  if (pathname === "/privacy") {
    return <LegalPages type="privacy" />;
  }

  return <MiniAppWalletRuntime />;
}

function MiniAppWalletRuntime() {
  const [isFarcasterMiniApp, setIsFarcasterMiniApp] = useState<boolean>();

  useEffect(() => {
    let isCurrent = true;
    void sdk.isInMiniApp().then((isInMiniApp) => {
      if (isCurrent) setIsFarcasterMiniApp(isInMiniApp);
    });
    return () => {
      isCurrent = false;
    };
  }, []);

  if (isFarcasterMiniApp === undefined) return null;
  return <DustEngineApp isFarcasterMiniApp={isFarcasterMiniApp} />;
}

function DustEngineApp({ isFarcasterMiniApp }: { isFarcasterMiniApp: boolean }) {
  const config = useMemo(() => createConfig(
    getDefaultConfig({
      appName: "Dust Cleaning Engine",
      chains: [base],
      walletConnectProjectId: "d6cceeb0d16f4b0724853476122511d7",
      transports: {
        [base.id]: http("https://mainnet.base.org"),
      },
      ssr: false,
      connectors: [
        ...(isFarcasterMiniApp
          ? [farcasterMiniAppWithDiagnostics()]
          : [
              injected(),
              coinbaseWallet({ appName: "Dust Cleaning Engine" }),
            ]),
      ],
    }),
  ), [isFarcasterMiniApp]);

  const [activeSection, setActiveSection] = useState<ProductSection>(() =>
    new URLSearchParams(window.location.search).get("section") === "ambassador" ? "ambassador" : "clean",
  );
  const diagnosticStateRef = useRef<WalletDiagnosticState>({
    status: "disconnected", activeSection, environment: isFarcasterMiniApp ? "farcaster-mini-app" : "normal-web",
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const selectSection = (section: ProductSection) => {
    logWalletDiagnostic("SECTION_BEFORE", { ...diagnosticStateRef.current, activeSection });
    setActiveSection(section);
    logWalletDiagnostic("SECTION_AFTER", { ...diagnosticStateRef.current, activeSection: section });
    setMobileMenuOpen(false);
  };

  if (window.location.pathname === "/genesis") {
    return (
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <ConnectKitProvider>
            <DustGenesisCampaign />
          </ConnectKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    );
  }

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider>
          <WalletDiagnostics isFarcasterMiniApp={isFarcasterMiniApp} activeSection={activeSection} config={config} diagnosticStateRef={diagnosticStateRef} />
          <div className="min-h-screen overflow-x-hidden bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
            <header className="border-b border-zinc-800/50 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-50">
              <div className="max-w-6xl mx-auto px-3 sm:px-4 min-h-16 py-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen((open) => !open)}
                    aria-label={mobileMenuOpen ? "Close product menu" : "Open product menu"}
                    aria-expanded={mobileMenuOpen}
                    className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-400 md:hidden"
                  >
                    {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
                  </button>
                  <div className="relative">
                    <Gear className="text-emerald-500" speed={5} />
                    <Gear
                      className="absolute -top-1 -right-1 scale-50 text-emerald-400"
                      speed={3}
                      reverse
                    />
                  </div>
                  <div className="flex flex-col -gap-1">
                    <h1 className="text-xl font-bold tracking-tighter uppercase italic leading-none">
                      Dust <span className="text-emerald-500">Engine</span>
                    </h1>
                    <span className="text-[8px] font-mono text-zinc-500 tracking-[0.2em] uppercase">
                      Model v1.0.4-BASE
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {activeSection === "clean" && (
                    <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-zinc-800 rounded-full border border-zinc-700">
                      <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      <span className="text-xs font-mono text-zinc-400">
                        BASE MAINNET
                      </span>
                    </div>
                  )}
                  <ConnectButton isFarcasterMiniApp={isFarcasterMiniApp} activeSection={activeSection} />
                </div>
              </div>
            </header>

            <MobileProductNavigation
              activeSection={activeSection}
              open={mobileMenuOpen}
              onSelect={selectSection}
            />
            <ReferralAttribution />
            <main className="max-w-6xl mx-auto flex min-w-0 gap-6 px-4 py-6 sm:py-8 md:gap-8 md:py-10">
              <ProductNavigation
                activeSection={activeSection}
                onSelect={selectSection}
              />
              <div className="min-w-0 flex-1">
                <div hidden={activeSection !== "clean"}>
                  <EngineCore isFarcasterMiniApp={isFarcasterMiniApp} />
                </div>
                {activeSection === "lend" && (
                  <ComingSoonPanel
                    icon={<Wrench size={24} strokeWidth={1.75} />}
                    title="Lend & Borrow"
                    description="Lending and borrowing tools are in development. This section will become available when the experience is ready."
                  />
                )}
                {activeSection === "liquidity" && (
                  <ComingSoonPanel
                    icon={<Coins size={24} strokeWidth={1.75} />}
                    title="Liquidity"
                    description="Liquidity tools are in development. This section will become available when the experience is ready."
                  />
                )}
                {activeSection === "bridge" && <BridgePanel isFarcasterMiniApp={isFarcasterMiniApp} />}
                {activeSection === "achievements" && <AchievementsSection />}
                {activeSection === "ambassador" && <AmbassadorPanel />}
              </div>
            </main>
            <AppFooter />
          </div>
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

type DustGenesisCampaignConfig = {
  chainId: number;
  contractAddress: Address | null;
  campaignStartTimestamp: number;
  campaignDeadline: number;
  chainTimestamp: number;
  tasks: Array<{ id: "profile" | "announcement"; label: string; url: string | null }>;
};
type DustGenesisMintAuthorization = {
  contractAddress: Address;
  recipient: Address;
  nonce: `0x${string}`;
  expiry: number;
  signature: `0x${string}`;
};

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

type DustGenesisClaimStage = "network" | "session" | "progress" | "authorization" | "submission" | "receipt";

const SAFE_DUST_GENESIS_API_ERRORS: Record<string, string> = {
  "Wallet authentication required": "Your wallet session expired. Reconnect or sign the wallet prompt, then try again.",
  "Invalid wallet address": "The connected wallet address could not be verified. Reconnect your wallet and try again.",
  "Invalid wallet proof": "Wallet verification failed. Sign the verification prompt again, then retry.",
  "Wallet proof expired or already used": "Wallet verification expired. Start a new claim attempt to verify again.",
  "Invalid wallet signature": "Wallet verification failed. Sign the verification prompt again, then retry.",
  "Invalid request": "The claim request was invalid. Please start a new claim attempt.",
  "Complete the profile task first": "Complete the profile task before continuing to the announcement task.",
  "Campaign tasks are incomplete": "The task steps are not yet complete. Wait for their status to update, then retry.",
  "Dust Genesis task progress could not be checked": "Task completion could not be checked. Check your connection and retry Claim NFT.",
  "Campaign task URL is not configured": "This campaign task is not available yet. Please try again later.",
  "Dust Genesis mint authorization is not configured": "Minting is not currently available. Please try again later.",
  "Wallet is not eligible to mint": "This wallet is not currently eligible to mint. Confirm the campaign is active and the task steps are complete.",
  "Dust Genesis eligibility could not be checked": "Wallet eligibility could not be checked. Please try again later.",
  "Dust Genesis campaign state could not be checked": "Campaign status could not be checked. Please try again later.",
  "Dust Genesis campaign configuration is invalid": "Campaign configuration is unavailable. Please try again later.",
  "Too many requests": "Too many claim requests were made. Wait a moment, then retry.",
};

function dustGenesisClaimErrorMessage(error: unknown, stage: DustGenesisClaimStage): string {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && isObject(current); depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === 4001 || code === "4001" || code === "ACTION_REJECTED") {
      return "The wallet request was rejected or cancelled. Retry Claim NFT when you are ready.";
    }
    current = (current as { cause?: unknown }).cause;
  }

  if (axios.isAxiosError(error)) {
    const responseData: unknown = error.response?.data;
    if (isObject(responseData)) {
      const serverMessage = (responseData as { error?: unknown }).error;
      if (typeof serverMessage === "string" && Object.prototype.hasOwnProperty.call(SAFE_DUST_GENESIS_API_ERRORS, serverMessage)) {
        return SAFE_DUST_GENESIS_API_ERRORS[serverMessage];
      }
    }
  }

  switch (stage) {
    case "network": return "Could not switch to Base. Select Base in your wallet, then retry Claim NFT.";
    case "session": return "Wallet verification could not be completed. Reconnect or approve the wallet prompt, then retry.";
    case "progress": return "Task completion could not be checked. Check your connection and retry Claim NFT.";
    case "authorization": return "Mint authorization could not be issued. Please retry Claim NFT.";
    case "submission": return "Your wallet could not submit the mint. Check the Base network and try Claim NFT again.";
    case "receipt": return "The mint transaction could not be confirmed. Check its status in your wallet before retrying.";
  }
}

function DustGenesisCampaign() {
  const { address, isConnected, chainId } = useAccount();
  const { setOpen } = useModal();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: base.id });
  const liveWalletRef = useRef(address?.toLowerCase() ?? null);
  const walletGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const [campaign, setCampaign] = useState<DustGenesisCampaignConfig | null>(null);
  const [campaignTimestamp, setCampaignTimestamp] = useState(0);
  const [session, setSession] = useState<{ token: string; wallet: string; expiresAt: number } | null>(null);
  const [progress, setProgress] = useState({ profileComplete: false, announcementComplete: false });
  const [startedTasks, setStartedTasks] = useState<Array<"profile" | "announcement">>([]);
  const [startingTask, setStartingTask] = useState<"profile" | "announcement" | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const taskOperationRef = useRef<{ wallet: string; generation: number } | null>(null);
  const progressRequestRef = useRef<{ key: string; promise: Promise<{ profileComplete: boolean; announcementComplete: boolean }> } | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [transactionPending, setTransactionPending] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    let active = true;
    const refreshCampaign = async () => {
      try {
        const { data } = await axios.get<DustGenesisCampaignConfig>("/api/dust-genesis/config");
        if (active) {
          setCampaign(data);
          setCampaignTimestamp((current) => Math.max(current, data.chainTimestamp));
        }
      } catch {
        if (active) {
          setCampaign(null);
          setCampaignTimestamp(0);
        }
      }
    };
    void refreshCampaign();
    const refreshInterval = window.setInterval(() => { void refreshCampaign(); }, 10_000);
    const clockInterval = window.setInterval(() => {
      setCampaignTimestamp((current) => current > 0 ? current + 1 : 0);
    }, 1_000);
    return () => {
      active = false;
      window.clearInterval(refreshInterval);
      window.clearInterval(clockInterval);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useLayoutEffect(() => {
    const nextWallet = address?.toLowerCase() ?? null;
    if (liveWalletRef.current === nextWallet) return;
    liveWalletRef.current = nextWallet;
    walletGenerationRef.current += 1;
    setSession(null);
    setProgress({ profileComplete: false, announcementComplete: false });
    setStartedTasks([]);
    setStartingTask(null);
    setTaskError(null);
    taskOperationRef.current = null;
    progressRequestRef.current = null;
    setClaiming(false);
    setTransactionPending(false);
    setClaimError(null);
    setShowSuccess(false);
  }, [address]);

  type WalletOperation = { wallet: string; generation: number };
  const captureWalletOperation = (wallet: Address): WalletOperation => ({
    wallet: wallet.toLowerCase(),
    generation: walletGenerationRef.current,
  });
  const isCurrentWalletOperation = (operation: WalletOperation) =>
    mountedRef.current
      && liveWalletRef.current === operation.wallet
      && walletGenerationRef.current === operation.generation;
  const requireCurrentWalletOperation = (operation: WalletOperation) => {
    if (!isCurrentWalletOperation(operation)) throw new Error("wallet_operation_stale");
  };

  const ensureWalletSession = async (operation: WalletOperation) => {
    requireCurrentWalletOperation(operation);
    if (!address || !isConnected || address.toLowerCase() !== operation.wallet) throw new Error("wallet_required");
    if (session?.wallet === operation.wallet && session.expiresAt > Date.now()) return session.token;
    const challenge = await axios.post("/api/dust-genesis/auth/nonce", { walletAddress: operation.wallet });
    requireCurrentWalletOperation(operation);
    const signature = await signMessageAsync({ account: operation.wallet as Address, message: challenge.data.message });
    requireCurrentWalletOperation(operation);
    const verified = await axios.post("/api/dust-genesis/auth/verify", {
      walletAddress: operation.wallet,
      nonce: challenge.data.nonce,
      signature,
    });
    requireCurrentWalletOperation(operation);
    const nextSession = {
      token: verified.data.accessToken as string,
      wallet: operation.wallet,
      expiresAt: Number(verified.data.expiresAt),
    };
    setSession(nextSession);
    return nextSession.token;
  };

  const updateProgress = (token: string, operation: WalletOperation) => {
    requireCurrentWalletOperation(operation);
    const requestKey = `${operation.wallet}:${operation.generation}:${token}`;
    if (progressRequestRef.current?.key === requestKey) return progressRequestRef.current.promise;
    const promise = (async () => {
      try {
        const response = await axios.post("/api/dust-genesis/progress", {}, {
          headers: { Authorization: `Bearer ${token}` },
        });
        requireCurrentWalletOperation(operation);
        const nextProgress = {
          profileComplete: Boolean(response.data.profileComplete),
          announcementComplete: Boolean(response.data.announcementComplete),
        };
        setProgress((current) => current.profileComplete === nextProgress.profileComplete
          && current.announcementComplete === nextProgress.announcementComplete ? current : nextProgress);
        setTaskError((current) => current?.startsWith("Task status could not be checked") ? null : current);
        return nextProgress;
      } catch (error) {
        if (isCurrentWalletOperation(operation)) {
          if (axios.isAxiosError(error) && error.response?.status === 401) setSession(null);
          setTaskError("Task status could not be checked. Please try again.");
        }
        throw error;
      }
    })();
    const request = { key: requestKey, promise };
    progressRequestRef.current = request;
    void promise.then(
      () => { if (progressRequestRef.current === request) progressRequestRef.current = null; },
      () => { if (progressRequestRef.current === request) progressRequestRef.current = null; },
    );
    return promise;
  };

  useEffect(() => {
    if (!session || session.wallet !== address?.toLowerCase() || !address) return;
    const operation = captureWalletOperation(address);
    void updateProgress(session.token, operation).catch(() => undefined);
  }, [address, session]);

  useEffect(() => {
    if (!session || session.wallet !== address?.toLowerCase() || startedTasks.length === 0 || !address) return;
    const hasPendingStartedTask = startedTasks.some((task) =>
      task === "profile" ? !progress.profileComplete : !progress.announcementComplete,
    );
    if (!hasPendingStartedTask) return;
    const operation = captureWalletOperation(address);
    const refresh = () => {
      if (document.visibilityState === "hidden" || !isCurrentWalletOperation(operation)) return;
      void updateProgress(session.token, operation).catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const interval = window.setInterval(refresh, 2_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [address, session, startedTasks, progress]);

  const openTask = async (
    event: MouseEvent<HTMLAnchorElement>,
    task: DustGenesisCampaignConfig["tasks"][number],
  ) => {
    if (!task.url) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    if (!isConnected || !address) {
      setOpen(true);
      return;
    }
    if (taskOperationRef.current) return;
    if (task.id === "announcement" && !progress.profileComplete) {
      return;
    }
    const operation = captureWalletOperation(address);
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    taskOperationRef.current = operation;
    setStartingTask(task.id);
    setTaskError(null);
    try {
      const token = await ensureWalletSession(operation);
      requireCurrentWalletOperation(operation);
      await axios.post(`/api/dust-genesis/tasks/${task.id}/start`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      requireCurrentWalletOperation(operation);
      setStartedTasks((current) => current.includes(task.id) ? current : [...current, task.id]);
      if (popup) popup.location.replace(task.url);
      void updateProgress(token, operation).catch(() => undefined);
      if (!popup) setTaskError("Your browser blocked the X tab. Allow pop-ups and select the task link again.");
    } catch (error) {
      popup?.close();
      if (!isCurrentWalletOperation(operation)) return;
      if (axios.isAxiosError(error) && error.response?.status === 401) setSession(null);
      if (!session) setOpen(true);
      setTaskError("The task could not be started. Please try again.");
    } finally {
      if (taskOperationRef.current === operation) {
        taskOperationRef.current = null;
        if (isCurrentWalletOperation(operation)) setStartingTask(null);
      }
    }
  };

  const hasExpectedMintEvent = (receipt: any, authorization: DustGenesisMintAuthorization, operation: WalletOperation) => {
    if (!campaign?.contractAddress || !isCurrentWalletOperation(operation)) return false;
    return receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== campaign.contractAddress?.toLowerCase()) return false;
      try {
        const event = decodeEventLog({ abi: DUST_GENESIS_ABI, eventName: "DustGenesisMinted", data: log.data, topics: log.topics });
        return event.args.recipient.toLowerCase() === operation.wallet
          && event.args.authorizationNonce.toLowerCase() === authorization.nonce.toLowerCase();
      } catch {
        return false;
      }
    });
  };

  const claimNft = async () => {
    setClaimError(null);
    if (!isConnected || !address) {
      setClaimError("Wallet connection was not completed. Connect a wallet, then retry Claim NFT.");
      setOpen(true);
      return;
    }
    if (!campaign?.contractAddress || !campaignActive || claiming) return;
    const operation = captureWalletOperation(address);
    let stage: DustGenesisClaimStage = "network";
    setClaiming(true);
    try {
      if (chainId !== base.id) await switchChainAsync({ chainId: base.id });
      requireCurrentWalletOperation(operation);
      stage = "session";
      const token = await ensureWalletSession(operation);
      stage = "progress";
      const currentProgress = await updateProgress(token, operation);
      if (!currentProgress.profileComplete || !currentProgress.announcementComplete) {
        setClaimError("The task steps are not yet complete. Wait for their status to update, then retry Claim NFT.");
        return;
      }
      stage = "authorization";
      const { data: authorization } = await axios.post<DustGenesisMintAuthorization>("/api/dust-genesis/authorization", {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      requireCurrentWalletOperation(operation);
      if (authorization.recipient.toLowerCase() !== operation.wallet
        || authorization.contractAddress.toLowerCase() !== campaign.contractAddress.toLowerCase()) {
        setClaimError("The mint authorization did not match this wallet or campaign. Start a new claim attempt.");
        return;
      }

      requireCurrentWalletOperation(operation);
      stage = "submission";
      const hash = await writeContractAsync({
        address: campaign.contractAddress,
        abi: DUST_GENESIS_ABI,
        functionName: "mint",
        args: [authorization.nonce, BigInt(authorization.expiry), authorization.signature],
        account: operation.wallet as Address,
        chain: base,
        chainId: base.id,
      });
      requireCurrentWalletOperation(operation);
      setTransactionPending(true);
      stage = "receipt";
      let receipt;
      try {
        receipt = await publicClient!.waitForTransactionReceipt({ hash, confirmations: 1 });
      } catch (error) {
        const replacement = error as { name?: string; receipt?: typeof receipt; cause?: { name?: string; receipt?: typeof receipt } };
        if (replacement.name === "TransactionReplacedError" || replacement.cause?.name === "TransactionReplacedError") {
          receipt = replacement.receipt ?? replacement.cause?.receipt;
        }
        if (!receipt) throw error;
      }
      requireCurrentWalletOperation(operation);
      if (receipt.status !== "success") {
        setClaimError("The mint transaction reverted. Check your wallet and network, then retry Claim NFT.");
        return;
      }
      if (!hasExpectedMintEvent(receipt, authorization, operation)) {
        setClaimError("The transaction was confirmed, but the Dust Genesis mint could not be verified. Check the transaction before retrying.");
        return;
      }
      setClaimError(null);
      setShowSuccess(true);
    } catch (error) {
      // Only expose safe, user-facing diagnostics; never show raw provider or server errors.
      if (!isCurrentWalletOperation(operation)) return;
      if (axios.isAxiosError(error) && error.response?.status === 401) setSession(null);
      setClaimError(dustGenesisClaimErrorMessage(error, stage));
    } finally {
      if (isCurrentWalletOperation(operation)) {
        setTransactionPending(false);
        setClaiming(false);
      }
    }
  };

  useEffect(() => {
    if (!showSuccess) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setShowSuccess(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showSuccess]);

  const tasksComplete = progress.profileComplete && progress.announcementComplete;
  const campaignActive = Boolean(campaign?.campaignStartTimestamp
    && campaignTimestamp >= campaign.campaignStartTimestamp
    && campaignTimestamp < campaign.campaignDeadline);
  const claimDisabled = claiming || !tasksComplete || !campaign?.contractAddress || !campaignActive;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-7 bg-zinc-950 px-5 py-8 text-zinc-100">
      <img src="/dust-genesis.png" alt="Dust Genesis NFT artwork" className="h-auto w-full max-w-md rounded-2xl object-contain" />
      <nav className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        {(campaign?.tasks ?? [
          { id: "profile" as const, label: "Follow the official Dust Engine X profile", url: "https://x.com/dustengineapp" },
          { id: "announcement" as const, label: "Open the official campaign announcement post", url: null },
        ]).map((task) => (
          (() => {
            const locked = task.id === "announcement" && !progress.profileComplete;
            const busy = startingTask === task.id;
            const unavailable = !task.url || locked || busy;
            return (
              <a
                key={task.id}
                href={task.url ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={task.id === "profile" ? "Follow the official Dust Engine X profile" : task.label}
                aria-disabled={unavailable || undefined}
                aria-busy={busy || undefined}
                onClick={(event) => { void openTask(event, task); }}
                className={`text-sm underline underline-offset-4 ${unavailable ? "cursor-not-allowed text-zinc-500" : "text-zinc-200 hover:text-white"}`}
              >
                {task.id === "profile" ? "Follow the official Dust Engine X profile" : task.label}
                {startingTask === task.id ? " · Opening…" : null}
              </a>
            );
          })()
        ))}
        {taskError && <p role="status" className="text-center text-xs text-amber-300">{taskError}</p>}
      </nav>
      <button
        type="button"
        onClick={() => { void claimNft(); }}
        disabled={claimDisabled}
        aria-busy={claiming || transactionPending}
        aria-label={transactionPending ? "Mint transaction pending" : claiming ? "Claim request pending" : "Claim NFT"}
        className="w-full max-w-md rounded-xl bg-emerald-500 px-5 py-3 text-sm font-black text-zinc-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Claim NFT
      </button>
      {claimError && (
        <p role="alert" aria-live="assertive" aria-atomic="true" className="w-full max-w-md text-center text-sm text-rose-300">
          {claimError}
        </p>
      )}
      {showSuccess && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-5 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSuccess(false); }}
        >
          <section role="dialog" aria-modal="true" aria-label="Mint confirmed" className="flex w-full max-w-sm flex-col items-center gap-5 rounded-3xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
            <img src="/dust-genesis.png" alt="Dust Genesis NFT artwork" className="h-auto w-full rounded-2xl object-contain" />
            <p className="text-center text-base font-semibold text-zinc-100">Dust Engine will never forget you.</p>
          </section>
        </div>
      )}
    </div>
  );
}

function WalletDiagnostics({ isFarcasterMiniApp, activeSection, config, diagnosticStateRef }: {
  isFarcasterMiniApp: boolean;
  activeSection: ProductSection;
  config: ReturnType<typeof createConfig>;
  diagnosticStateRef: MutableRefObject<WalletDiagnosticState>;
}) {
  const { address, chainId, connector, status } = useAccount();

  const snapshot: WalletDiagnosticState = {
    status, address, chainId, connectorId: connector?.id, connectorName: connector?.name,
    activeSection, environment: isFarcasterMiniApp ? "farcaster-mini-app" : "normal-web",
  };
  diagnosticStateRef.current = snapshot;
  const previousStateRef = useRef(snapshot);

  useEffect(() => {
    logWalletDiagnostic("WAGMI_RUNTIME_MOUNT", snapshot, { configIdentity: walletConfigIdentity(config) });
    return () => logWalletDiagnostic("WAGMI_RUNTIME_UNMOUNT", snapshot, { configIdentity: walletConfigIdentity(config) });
  }, []);

  useEffect(() => {
    logWalletDiagnostic("WAGMI_CONFIG_IDENTITY", snapshot, { configIdentity: walletConfigIdentity(config) });
  }, [config]);

  useEffect(() => {
    if (activeSection === "clean") logWalletDiagnostic("CLEAN_DUST_ACTIVE", snapshot);
    if (activeSection === "bridge") logWalletDiagnostic("BRIDGE_ACTIVE", snapshot);
  }, [activeSection]);

  useEffect(() => {
    const previous = previousStateRef.current;
    if (isFarcasterMiniApp && previous.status !== status) {
      if (status === "disconnected") logWalletDiagnostic("CONNECTOR_EVENT", snapshot, { event: "disconnect" });
      if (status === "connected") logWalletDiagnostic("CONNECT_SUCCESS", snapshot);
    }
    if (isFarcasterMiniApp && previous.address !== address) {
      logWalletDiagnostic("CONNECTOR_EVENT", snapshot, { event: "accountsChanged", previousAddress: previous.address });
    }
    if (isFarcasterMiniApp && previous.chainId !== chainId) {
      logWalletDiagnostic("CONNECTOR_EVENT", snapshot, { event: "chainChanged", previousChainId: previous.chainId });
    }
    previousStateRef.current = snapshot;
  }, [status, address, chainId, isFarcasterMiniApp]);

  return null;
}

function AchievementsSection() {
  const { address } = useAccount();

  return <AchievementsPanel address={address} />;
}

function ReferralAttribution() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();

  useEffect(() => {
    const referralCode = new URLSearchParams(window.location.search).get("ref")?.trim();
    if (!referralCode) return;

    // Keep attribution available until a wallet is connected. The server validates the
    // code and records only a pending attribution; it never creates points from a click.
    window.localStorage.setItem("dust-engine-referral-code", referralCode);
  }, []);

  useEffect(() => {
    const referralCode = window.localStorage.getItem("dust-engine-referral-code");
    if (!address || !referralCode) return;
    const attemptKey = `dust-engine-referral-attribution:${address.toLowerCase()}:${referralCode}`;
    if (window.sessionStorage.getItem(attemptKey)) return;
    window.sessionStorage.setItem(attemptKey, "attempted");

    void (async () => {
      try {
        const nonce = await axios.post("/api/referrals/nonce", { walletAddress: address, referralCode });
        const signature = await signMessageAsync({ account: address, message: nonce.data.message });
        await axios.post("/api/referrals/attribute", { walletAddress: address, nonce: nonce.data.nonce, signature });
      } catch {
        // The signed proof prevents a third party from attributing someone else's wallet.
      }
    })();
  }, [address, signMessageAsync]);

  return null;
}

function ConnectButton({ isFarcasterMiniApp, activeSection }: { isFarcasterMiniApp: boolean; activeSection: ProductSection }) {
  const { connect, connectors } = useConnect();
  const account = useAccount();

  return (
    <div className="shrink-0">
      <ConnectKitButton.Custom>
        {({ isConnected, show, truncatedAddress }) => (
          <button
            type="button"
            onClick={() => {
              if (isFarcasterMiniApp && !isConnected) {
                logWalletDiagnostic("HEADER_FARCASTER_CONNECT", {
                  status: account.status, address: account.address, chainId: account.chainId,
                  connectorId: account.connector?.id, connectorName: account.connector?.name, activeSection,
                  environment: isFarcasterMiniApp ? "farcaster-mini-app" : "normal-web",
                });
                const farcasterConnector = connectors.find((connector) => connector.id === "farcaster");
                if (farcasterConnector) connect({ connector: farcasterConnector });
                return;
              }
              show();
            }}
            className="flex h-11 max-w-[150px] items-center gap-2 rounded-xl bg-zinc-800 px-3 text-sm font-semibold text-zinc-100 transition-colors hover:bg-zinc-700 sm:max-w-none sm:px-4"
          >
            {isConnected ? (
              <span className="truncate">
                {truncatedAddress}
              </span>
            ) : (
              <span>Connect Wallet</span>
            )}
          </button>
        )}
      </ConnectKitButton.Custom>
    </div>
  );
}

function ProductNavigation({
  activeSection,
  onSelect,
}: {
  activeSection: ProductSection;
  onSelect: (section: ProductSection) => void;
}) {
  const sections: {
    id: ProductSection;
    label: string;
    icon: ReactNode;
    comingSoon?: boolean;
    badge?: string;
  }[] = [
    { id: "clean", label: "Clean Dust", icon: <Coins size={16} /> },
    { id: "bridge", label: "Bridge", icon: <ArrowRight size={16} /> },
    {
      id: "liquidity",
      label: "Liquidity",
      icon: <Coins size={16} />,
      comingSoon: true,
    },
    {
      id: "lend",
      label: "Lend & Borrow",
      icon: <Wrench size={16} />,
      comingSoon: true,
    },
    {
      id: "achievements",
      label: "Achievements",
      icon: <Trophy size={16} />,
    },
    {
      id: "ambassador",
      label: "Ambassador Program",
      icon: <Users size={16} />,
      badge: "Season 1",
    },
  ];

  return (
    <nav
      aria-label="Dust Engine product sections"
      className="sticky top-24 hidden h-fit w-56 shrink-0 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-1.5 shadow-lg shadow-black/10 md:block"
    >
      <div className="space-y-1">
        {sections.map((section) => {
          const isActive = activeSection === section.id;

          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onSelect(section.id)}
              aria-pressed={isActive}
              className={cn(
                "flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition-colors",
                isActive
                  ? "bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/30"
                  : "text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200",
              )}
            >
              <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide">
                {section.icon}
                {section.label}
              </span>
              {section.comingSoon && (
                <span className="shrink-0 whitespace-nowrap rounded-full border border-zinc-700 bg-zinc-950/70 px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-zinc-500">
                  Soon
                </span>
               )}

               {section.badge && (
                 <span className="shrink-0 whitespace-nowrap rounded-full border border-zinc-700 bg-zinc-950/70 px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider text-zinc-500">
                   {section.badge}
                 </span>
               )}
            </button>
          );
        })}
        <a
          href="/genesis"
          aria-label="Open the Dust Genesis claim page"
          className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wide text-zinc-400 transition-colors hover:bg-zinc-800/80 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70"
        >
          <span className="flex items-center gap-2"><ExternalLink size={16} />CLAIM NFT</span>
        </a>
      </div>
    </nav>
  );
}

function MobileProductNavigation({
  activeSection,
  onSelect,
  open,
}: {
  activeSection: ProductSection;
  onSelect: (section: ProductSection) => void;
  open: boolean;
}) {
  const sections: { id: ProductSection; label: string; badge?: string }[] = [
    { id: "clean", label: "Clean Dust" },
    { id: "bridge", label: "Bridge" },
    { id: "liquidity", label: "Liquidity", badge: "Soon" },
    { id: "lend", label: "Lend & Borrow", badge: "Soon" },
    { id: "achievements", label: "Achievements" },
    { id: "ambassador", label: "Ambassador Program", badge: "Season 1" },
  ];

  if (!open) return null;

  return (
    <nav
      aria-label="Dust Engine mobile product sections"
      className="fixed inset-x-0 top-[65px] z-40 border-b border-zinc-800 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-md md:hidden"
    >
      <div className="mx-auto grid max-w-6xl gap-1">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelect(section.id)}
            className={cn(
              "flex min-h-12 w-full items-center justify-between rounded-xl px-4 text-left text-sm font-bold uppercase tracking-wide",
              activeSection === section.id
                ? "bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/30"
                : "text-zinc-300 hover:bg-zinc-900",
            )}
          >
            <span className="min-w-0 truncate">{section.label}</span>
            {section.badge && (
              <span className="ml-3 shrink-0 whitespace-nowrap rounded-full border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-[9px] font-mono text-zinc-500">
                {section.badge}
              </span>
            )}
          </button>
        ))}
        <a
          href="/genesis"
          aria-label="Open the Dust Genesis claim page"
          className="flex min-h-12 w-full items-center rounded-xl px-4 text-left text-sm font-bold uppercase tracking-wide text-zinc-300 transition-colors hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70"
        >
          CLAIM NFT
        </a>
      </div>
    </nav>
  );
}

function ComingSoonPanel({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <section className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl sm:p-10">
      <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-emerald-500/5 blur-2xl" />
      <div className="relative mx-auto flex max-w-md flex-col items-center text-center">
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
          {icon}
        </div>
        <span className="mb-3 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-emerald-400">
          Coming Soon
        </span>
        <h2 className="text-2xl font-black uppercase italic tracking-tight text-zinc-100 sm:text-3xl">
          {title}
        </h2>
        <p className="mt-3 text-sm leading-6 text-zinc-400">{description}</p>
        <p className="mt-6 text-[10px] font-mono uppercase tracking-wider text-zinc-600">
          No wallet actions are available in this section.
        </p>
      </div>
    </section>
  );
}

function AppFooter() {
  return (
    <footer className="border-t border-zinc-800/70 bg-zinc-950/70">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 px-4 py-6 text-center sm:flex-row sm:justify-between sm:text-left">
        <span className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
          Dust <span className="text-emerald-500">Engine</span>
        </span>
        <div className="flex items-center gap-2">
          <a
            href="https://x.com/dustengineapp"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Follow Dust Engine on X"
            title="Follow Dust Engine on X"
            className="group flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/60 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70"
          >
            <img
              src="/x-logo.svg"
              width="18"
              height="18"
              alt=""
              className="opacity-60 invert transition-opacity group-hover:opacity-100"
            />
          </a>
          <a
            href="https://farcaster.xyz/dustengine"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Follow Dust Engine on Farcaster"
            title="Follow Dust Engine on Farcaster"
            className="group flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/60 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70"
          >
            <img
              src="/farcaster-logo.svg"
              width="24"
              height="24"
              alt=""
              className="opacity-60 transition-opacity group-hover:opacity-100"
            />
          </a>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] font-mono uppercase tracking-wider text-zinc-600">
          <a
            href="/terms"
            className="transition-colors hover:text-zinc-300"
          >
            Terms
          </a>
          <span>·</span>
          <a
            href="/privacy"
            className="transition-colors hover:text-zinc-300"
          >
            Privacy
          </a>
          <span>·</span>
          <span>© 2026 Dust Engine</span>
        </div>
      </div>
    </footer>
  );
}

function EngineCore({ isFarcasterMiniApp }: { isFarcasterMiniApp: boolean }) {
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const { address, isConnected, status, chainId, connector } = useAccount();
  const { setOpen } = useModal();
  const publicClient = usePublicClient();
  const scanRunGuardRef = useRef(createScanRunGuard());

  const scannerRpcClient = createPublicClient({
    chain: base,
    transport: http("/api/base-rpc"),
  });

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [scanAddress, setScanAddress] = useState("");
  const [apiStatus, setApiStatus] = useState<{
    debank: boolean;
    oneinch: boolean;
  }>({ debank: false, oneinch: false });
  const [log, setLog] = useState<string[]>([]);
  const [customAddress, setCustomAddress] = useState("");
  const [isAddingCustom, setIsAddingCustom] = useState(false);
  const [dustThreshold, setDustThreshold] = useState(3.0);
  useEffect(() => {
    const checkApi = async () => {
      try {
        const res = await axios.get("/api/health");
        setApiStatus({
          debank: !!res.data.keys?.debank,
          oneinch: !!res.data.keys?.oneinch,
        });
      } catch (e) {
        console.error("Health check failed");
      }
    };
    checkApi();
  }, []);

  const addLog = (msg: string) => {
    setLog((prev) => [msg, ...prev].slice(0, 5));
  };

  const analyze = async (targetAddress?: string) => {
    if (!scanRunGuardRef.current.tryAcquire()) {
      addLog("SCAN ALREADY IN PROGRESS");
      return;
    }

    try {
    const addressToScan = targetAddress || address;

    const liquidityMap: Record<string, number> = {};

    if (!addressToScan) {
      addLog("ERROR: NO ADDRESS TO SCAN");
      return;
    }

    // If we have a publicClient, check chain. If not, we'll proceed (might fail if needed)
    // Only check chain if we are scanning the connected wallet
    if (publicClient && !targetAddress) {
      const chainId = await publicClient.getChainId();
      if (chainId !== base.id) {
        addLog("ERROR: WRONG NETWORK (SWITCH TO BASE)");
        alert(
          "Please switch your wallet to the Base network to use the Dust Engine.",
        );
        return;
      }
    }

    if (!window.navigator.onLine) {
      addLog("ERROR: NO INTERNET CONNECTION");
      setIsAnalyzing(false);
      return;
    }

    setIsAnalyzing(true);
    addLog(
      `SCANNING: ${addressToScan.slice(0, 6)}...${addressToScan.slice(-4)}`,
    );

    try {
      // --- Phase 1: Multi-Source Discovery ---
      addLog("INITIATING AGGRESSIVE SCAN...");
      let discoveredTokens: any[] = [];
      let blockscoutQuotes: Record<string, BlockscoutQuote> | undefined;
      const discoveredLogos: Record<string, string> = {};
      let lifiLogoPromise: Promise<Record<string, string>> | undefined;
      let discoveryIncomplete = false;
      const targetScanAddresses = [
        "0x696f9436b67233384889472cd7cd58a6fb5df4f1",
        "0x5b2193fdc451c1f847be09ca9d13a4bf60f8c86b",
        "0x1111111111166b7fe7bd91427724b487980afc69",
      ];
      const targetScanStages = new Map(targetScanAddresses.map((targetAddress) => [targetAddress, {
        address: targetAddress,
        discoveryStatus: "not_received" as string,
        discoveryPresent: false,
        discoverySources: [] as string[],
        deduplicatedPresent: false,
        finalScanListPresent: false,
        balanceRequestMade: false,
        balanceReadStatus: "not_requested" as string,
        balanceReadErrorCategory: null as string | null,
        rawBalance: null as string | null,
        formattedBalance: null as string | null,
        positiveBalance: false,
        metadataStatus: "not_requested" as string,
        symbol: null as string | null,
        decimals: null as number | null,
        pricingInput: false,
      }]));
      const logTargetScanStage = (stage: string) => {
        if (!import.meta.env.DEV) return;
        console.info(`[Clean Dust] target scan pipeline ${stage}`, JSON.stringify(
          targetScanAddresses.map((targetAddress) => targetScanStages.get(targetAddress)),
          null,
          2,
        ));
      };

      // 1.1 Backend Deep Scan
      try {
        const targetAddress = addressToScan || address;

        const backendRes = await axios.get(`/api/scan/${targetAddress}`, {
          timeout: 60000,
        });

        console.log("TOKEN COUNT:", backendRes.data?.tokens?.length);

        const discoveryTokens = Array.isArray(backendRes.data?.tokens) ? backendRes.data.tokens : [];
        const providerLogos = backendRes.data?.blockscoutLogos && typeof backendRes.data.blockscoutLogos === "object"
          ? backendRes.data.blockscoutLogos as Record<string, unknown>
          : undefined;
        let discoveredLogoCount = 0;
        for (const token of discoveryTokens) {
          if (typeof token?.address !== "string") continue;
          const logoURI = resolveTokenLogoURI(base.id, token.address, token.logoURI, providerLogos);
          if (logoURI) {
            discoveredLogos[tokenLogoKey(base.id, token.address)] = logoURI;
            discoveredLogoCount += 1;
          }
        }
        if (discoveredLogoCount < discoveryTokens.length) {
          lifiLogoPromise = getSupportedTokenLogoMap(base.id).catch((error) => {
            if (import.meta.env.DEV) console.info("[Token logos] LI.FI metadata unavailable", { chainId: base.id, errorType: error instanceof Error ? error.name : "unknown" });
            return {};
          });
        }
        if (import.meta.env.DEV) {
          console.info("[Token logos] Blockscout discovery", {
            chainId: base.id,
            discoveredTokenCount: discoveryTokens.length,
            usableLogoCount: discoveredLogoCount,
            addressMapEntryCount: providerLogos ? Object.keys(providerLogos).length : 0,
          });
        }
        for (const targetAddress of targetScanAddresses) {
          const target = targetScanStages.get(targetAddress)!;
          target.discoveryStatus = typeof backendRes.data?.status === "string" ? backendRes.data.status : "missing_status";
          const discovered = discoveryTokens.find((token: any) => token?.address?.toLowerCase() === targetAddress);
          target.discoveryPresent = !!discovered;
          target.discoverySources = Array.isArray(discovered?.sources) ? discovered.sources : [];
        }
        logTargetScanStage("discovery_response");
        if (import.meta.env.DEV && Array.isArray(backendRes.data?.discovery?.sources)) {
          console.info("[Clean Dust] discovery provider summary", JSON.stringify(
            backendRes.data.discovery.sources.map((source: any) => ({
              source: source.source,
              status: source.status,
              pages: source.pages,
              candidateCount: Array.isArray(source.candidates) ? source.candidates.length : 0,
              targetPresence: Object.fromEntries(targetScanAddresses.map((targetAddress) => [
                targetAddress,
                Array.isArray(source.candidates) && source.candidates.some((candidate: any) => candidate?.address?.toLowerCase() === targetAddress),
              ])),
            })),
            null,
            2,
          ));
        }

        if (backendRes.data?.status === "discovery_unavailable") {
          addLog("SCANNER UNAVAILABLE: RETRY IN A MOMENT");
          return;
        }

        if (backendRes.data?.status === "success" || backendRes.data?.status === "partial_success") {
          discoveryIncomplete = backendRes.data.status === "partial_success"
            || backendRes.data.discovery?.sources?.some((source: any) => source.status === "capped");
          blockscoutQuotes = backendRes.data.blockscoutQuotes;
          discoveredTokens = [
            ...discoveredTokens,
            // Discovery providers supply addresses only. The existing Base RPC
            // multicall below remains the sole source of wallet balances.
            ...backendRes.data.tokens.map((t: any) => ({ address: t.address, logoURI: t.logoURI, source: t.sources?.join(",") })),
          ];
          addLog(`BACKEND: DISCOVERED ${backendRes.data.tokens.length} ASSETS`);
          if (discoveryIncomplete) addLog("DISCOVERY PARTIAL: SOME PROVIDERS FAILED OR REACHED A CAP");
        }
      } catch (e: any) {
        console.warn("Backend scan failed", e instanceof Error ? e.name : "unknown_error");
        for (const targetAddress of targetScanAddresses) {
          targetScanStages.get(targetAddress)!.discoveryStatus = "request_failed";
        }
        logTargetScanStage("discovery_response");
        if (e.response?.status === 503 || e.response?.data?.status === "discovery_unavailable") {
          addLog("SCANNER UNAVAILABLE: RETRY IN A MOMENT");
          return;
        }
        addLog("SCANNER UNAVAILABLE: RETRY IN A MOMENT");
        return;
      }

      // 1.2 1inch discovery disabled
      // 1inch returns ALL Base tokens which breaks dust detection
      let oneInchTokens: any[] = [];
      addLog("1INCH DISCOVERY DISABLED (USING WALLET TOKENS ONLY)");

      // 1.3 Deep Scan (DexScreener Search for any missing assets)
      // addLog("DEEP SCAN: CHECKING DEX LIQUIDITY...");

      // ❌ TEMP DISABLED (too slow)
      /*
      try {
        // Find tokens that have balances but might not be in our lists
        const potentialAddresses = discoveredTokens.map(t => t.address).filter(Boolean);
        
        if (potentialAddresses.length > 0) {
          const dsRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${potentialAddresses.slice(0, 100).join(',')}`, { timeout: 8000 });
          
          if (dsRes.data?.pairs) {
            dsRes.data.pairs.forEach((pair: any) => {
              if (pair.baseToken?.address && pair.chainId === 'base') {
                const addr = pair.baseToken.address as Address;
                const addrLower = addr.toLowerCase();

                liquidityMap[addrLower] = pair.liquidity?.usd || 0;

                if (!discoveredTokens.some(dt => dt.address?.toLowerCase() === addrLower)) {
                  discoveredTokens.push({
                    symbol: pair.baseToken.symbol || '???',
                    address: addr,
                    decimals: 18,
                    priceUsd: parseFloat(pair.priceUsd || '0')
                  });
                }
              }
            });
          }
        }
      } catch (e) { console.warn("Deep scan failed", e instanceof Error ? e.name : "unknown_error"); }
      */
      console.log("LIQUIDITY MAP ENTRY COUNT:", Object.keys(liquidityMap).length);

      const candidatesByAddress = new Map<string, any>();
      const mergeCandidate = (candidate: any) => {
        if (!candidate.address) return;

        const key = candidate.address.toLowerCase();
        const existing = candidatesByAddress.get(key);

        if (!existing) {
          candidatesByAddress.set(key, candidate);
          return;
        }

        candidatesByAddress.set(key, {
          ...existing,
          address: existing.address || candidate.address,
          symbol:
            existing.symbol && existing.symbol !== "???"
              ? existing.symbol
              : candidate.symbol || existing.symbol,
          logoURI: mergeTokenLogoURI(existing.logoURI, candidate.logoURI),
          name: existing.name || candidate.name,
          decimals: existing.decimals ?? candidate.decimals,
          balance:
            existing.balance && existing.balance !== "0"
              ? existing.balance
              : candidate.balance,
          priceUsd:
            existing.priceUsd > 0 ? existing.priceUsd : candidate.priceUsd,
          source:
            existing.source === candidate.source
              ? existing.source
              : `${existing.source},${candidate.source}`,
        });
      };

      discoveredTokens.forEach(mergeCandidate);
      oneInchTokens.forEach(mergeCandidate);

      for (const targetAddress of targetScanAddresses) {
        targetScanStages.get(targetAddress)!.deduplicatedPresent = candidatesByAddress.has(targetAddress);
      }
      logTargetScanStage("deduplicated_candidates");

      const finalScanList = Array.from(candidatesByAddress.values())
        .filter((t) => {
          if (!t.address) return false;

          const addrLower = t.address.toLowerCase();

          if (addrLower === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
            return false;

          // 🔥 LIQUIDITY CHECK
          const liquidity = liquidityMap[addrLower] || 0;

          // 🔥 DEBUG LOG (ADD HERE)
          // console.log("FILTER CHECK:", {
          //  symbol: t.symbol,
          //  address: addrLower,
          //  liquidity
          // });

          // keep all tokens (we filter later based on value)
          return true;
        })
        .map((t) => {
          return {
            ...t,
            symbol: t.symbol || "???",
            address: t.address as Address,
          };
        });

      for (const targetAddress of targetScanAddresses) {
        targetScanStages.get(targetAddress)!.finalScanListPresent = finalScanList.some((token) => token.address.toLowerCase() === targetAddress);
      }
      logTargetScanStage("balance_request_candidates");

      addLog(`INDEXER PROVIDED TOKENS`);
      await withConsoleTimer("⏱️ TOTAL SCAN", async () => {

      addLog(`VERIFYING ${finalScanList.length} ASSETS ON-CHAIN...`);

      // ✅ FAST MODE: skip 1inch validation
      const validTokens = finalScanList;

      // 2. Browser-side Base RPC balance verification.
      const chunkSize = 100;
      const balancesByAddress = new Map<string, bigint>();
      const balanceReadStatuses = new Map<string, string>();
      let individualBalanceRetriesRemaining = MAX_INDIVIDUAL_BALANCE_RETRIES_PER_SCAN;
      for (let i = 0; i < validTokens.length; i += chunkSize) {
        const chunk = validTokens.slice(i, i + chunkSize);
        const targetChunkTokens = chunk.filter((token) => targetScanStages.has(token.address.toLowerCase()));
        targetChunkTokens.forEach((token) => {
          const target = targetScanStages.get(token.address.toLowerCase())!;
          target.balanceRequestMade = true;
          target.balanceReadStatus = "pending";
        });
        addLog(
          `SCANNING CHUNK ${Math.floor(i / chunkSize) + 1}/${Math.ceil(finalScanList.length / chunkSize)}...`,
        );

        let success = false;
        let retries = 0;
        while (!success && retries < 2) {
          try {
            const multicallResults = await (scannerRpcClient as any).multicall({
              allowFailure: true,
              contracts: chunk.map((token) => ({
                address: token.address,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [addressToScan as Address],
              })),
            });
            const retried = await retryFailedBalanceReads(
              chunk,
              multicallResults,
              async (token) => ({
                status: "success",
                result: await (scannerRpcClient as any).readContract({
                  address: token.address,
                  abi: ERC20_ABI,
                  functionName: "balanceOf",
                  args: [addressToScan as Address],
                }),
              }),
              isTransientBalanceReadError,
              undefined,
              individualBalanceRetriesRemaining,
            );
            individualBalanceRetriesRemaining -= retried.retriedCount;
            const results = retried.results;
            targetChunkTokens.forEach((token) => {
              const targetAddress = token.address.toLowerCase();
              const result = results[chunk.findIndex((candidate) => candidate.address.toLowerCase() === targetAddress)];
              const target = targetScanStages.get(targetAddress)!;
              if (result?.status === "success" && typeof result.result === "bigint") {
                target.rawBalance = result.result.toString();
                target.balanceReadStatus = result.result > 0n ? "verified_positive" : "verified_zero";
                balanceReadStatuses.set(targetAddress, target.balanceReadStatus);
              } else {
                target.balanceReadStatus = result?.status === "failure"
                  ? `unavailable_${metadataErrorCategory(result.error)}`
                  : "unavailable_missing_or_undecodable_result";
                if (result?.error) target.balanceReadErrorCategory = metadataErrorCategory(result.error);
                balanceReadStatuses.set(targetAddress, target.balanceReadStatus);
              }
            });
            recordSuccessfulBalances(balancesByAddress, chunk, results);
            const verifiedResults = results.filter((result: any) => result?.status === "success" && typeof result.result === "bigint");
            console.info("[Clean Dust] balance chunk summary", {
              chunkIndex: Math.floor(i / chunkSize) + 1,
              candidateCount: chunk.length,
              verifiedCount: verifiedResults.length,
              positiveCount: verifiedResults.filter((result: any) => result.result > 0n).length,
              zeroCount: verifiedResults.filter((result: any) => result.result === 0n).length,
              unavailableCount: chunk.length - verifiedResults.length,
              retriedCount: retried.retriedCount,
              retryOmittedCount: retried.retryOmittedCount,
            });
            success = true;
          } catch (balanceError) {
            retries += 1;
            if (retries === 2) {
              targetChunkTokens.forEach((token) => {
                const targetAddress = token.address.toLowerCase();
                const target = targetScanStages.get(targetAddress)!;
                target.balanceReadStatus = `multicall_request_failed_after_retries:${metadataErrorCategory(balanceError)}`;
                target.balanceReadErrorCategory = metadataErrorCategory(balanceError);
                balanceReadStatuses.set(targetAddress, target.balanceReadStatus);
              });
              addLog(`CHUNK ${Math.floor(i / chunkSize) + 1} FAILED.`);
            } else {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      console.time("⏱️ BALANCE FETCH");
      const tokensWithBalance: typeof validTokens = [];
      const balancesForTokens: bigint[] = [];
      verifiedPositiveBalances(validTokens, balancesByAddress).forEach(({ token, balance }) => {
        tokensWithBalance.push(token);
        balancesForTokens.push(balance);
      });

      for (const targetAddress of targetScanAddresses) {
        const target = targetScanStages.get(targetAddress)!;
        target.positiveBalance = tokensWithBalance.some((token) => token.address.toLowerCase() === targetAddress);
        if (target.balanceReadStatus === "pending") target.balanceReadStatus = balanceReadStatuses.get(targetAddress) || "no_result_recorded";
      }
      logTargetScanStage("balance_verification");

      addLog(`BALANCES DETECTED: ${tokensWithBalance.length} ASSETS`);

      const metadataByAddress = new Map<string, { decimals: number; symbol: string }>();
      const metadataChunkSize = 50;
      let metadataFailures = 0;
      for (let i = 0; i < tokensWithBalance.length; i += metadataChunkSize) {
        const chunk = tokensWithBalance.slice(i, i + metadataChunkSize);
        const metadataChunkIndex = Math.floor(i / metadataChunkSize) + 1;
        const metadataTokens = chunk.flatMap((token) => {
          if (isAddress(token.address)) return [{ token, address: getAddress(token.address) }];
          metadataFailures += 1;
          console.warn("Token metadata address skipped", {
            metadataChunkIndex,
            chunkSize: chunk.length,
            attempt: 0,
            category: "invalid_address",
          });
          return [];
        });

        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const results = await (scannerRpcClient as any).multicall({
              allowFailure: true,
              contracts: metadataTokens.flatMap(({ address: tokenAddress }) => [
                { address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" },
                { address: tokenAddress, abi: ERC20_ABI, functionName: "symbol" },
              ]),
            });
            const successfulMetadataResults = results.filter((result: any) => result.status === "success").length;
            console.info("Token metadata multicall result", {
              metadataChunkIndex,
              chunkSize: metadataTokens.length,
              attempt,
              successfulMetadataResults,
              failedMetadataResults: results.length - successfulMetadataResults,
            });
            metadataTokens.forEach(({ token }, index) => {
              const metadata = resolveErc20Metadata(results[index * 2], results[index * 2 + 1]);
              if (!metadata) {
                metadataFailures += 1;
                return;
              }
              metadataByAddress.set(token.address.toLowerCase(), metadata);
            });
            break;
          } catch (metadataError) {
            console.warn("Token metadata multicall failed", {
              metadataChunkIndex,
              chunkSize: metadataTokens.length,
              attempt,
              category: metadataErrorCategory(metadataError),
            });
            if (attempt === 2) {
              metadataFailures += metadataTokens.length;
            } else {
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          }
        }
      }

      const tokensWithMetadata: typeof validTokens = [];
      const balancesWithMetadata: bigint[] = [];
      tokensWithBalance.forEach((token, index) => {
        const metadata = metadataByAddress.get(token.address.toLowerCase());
        const target = targetScanStages.get(token.address.toLowerCase());
        if (target) {
          target.metadataStatus = metadata ? "valid" : "missing_or_invalid_decimals";
          target.symbol = metadata?.symbol ?? null;
          target.decimals = metadata?.decimals ?? null;
        }
        if (!metadata) return;
        const logoURI = discoveredLogos[tokenLogoKey(base.id, token.address)];
        tokensWithMetadata.push({ ...token, ...metadata, ...(logoURI ? { logoURI } : {}) });
        balancesWithMetadata.push(balancesForTokens[index]);
      });
      if (import.meta.env.DEV) {
        console.info("[Token logos] Blockscout positive balances", {
          chainId: base.id,
          positiveBalanceTokenCount: tokensWithBalance.length,
          matchedLogoCount: tokensWithMetadata.filter((token) => usableTokenLogoUrl(token.logoURI)).length,
        });
      }
      for (const targetAddress of targetScanAddresses) {
        const target = targetScanStages.get(targetAddress)!;
        if (!target.positiveBalance) target.metadataStatus = "not_requested_without_positive_balance";
      }
      logTargetScanStage("metadata_resolution");
      if (metadataFailures > 0) addLog(`METADATA UNAVAILABLE FOR ${metadataFailures} ASSETS`);
      addLog(`METADATA RESOLVED: ${tokensWithMetadata.length} ASSETS`);

      const normalizedBalances = tokensWithMetadata.map((token, i) => {
        const raw = balancesWithMetadata[i];
        const decimals = token.decimals;

        const balance = Number(raw) / Math.pow(10, decimals);

        return {
          ...token,
          balance,
        };
      });
      for (let i = 0; i < tokensWithMetadata.length; i += 1) {
        const target = targetScanStages.get(tokensWithMetadata[i].address.toLowerCase());
        if (target) target.formattedBalance = formatUnits(balancesWithMetadata[i], tokensWithMetadata[i].decimals);
      }

      console.log("NORMALIZED TOKEN COUNT:", normalizedBalances.length);

      console.timeEnd("⏱️ BALANCE FETCH");

      console.log("TOKENS WITH METADATA COUNT:", tokensWithMetadata.length);
      console.log("BALANCE RESULTS COUNT:", balancesWithMetadata.length);

      if (tokensWithMetadata.length === 0) {
        addLog("NO TOKENS WITH USABLE ON-CHAIN METADATA");
        setIsAnalyzing(false);
        return;
      }

      // --- Phase 3: Price Fetching & Verification ---
      console.time("⏱️ PRICE FETCH");
      const priceEvidenceStartedAt = performance.now();
      addLog(`FETCHING PRICES FOR ${tokensWithMetadata.length} ASSETS...`);
      const quotes: Record<string, PriceQuote> = createInitialQuotes(LOCAL_KNOWN_PRICES, blockscoutQuotes);
      const priceCandidates = indicativePriceAddresses(tokensWithMetadata, WETH);
      for (const targetAddress of targetScanAddresses) {
        targetScanStages.get(targetAddress)!.pricingInput = priceCandidates.includes(targetAddress);
      }
      logTargetScanStage("pricing_input");
      const dexScreenerMetrics = createProviderRequestMetrics();
      const dexScreenerQuotes = await fetchDexScreenerQuotes(
        priceCandidates,
        (url) => measureProviderRequest(dexScreenerMetrics, () => axios.get(url, { timeout: 8000 })),
      );
      const canonicalAddresses = new Set(Object.keys(LOCAL_KNOWN_PRICES).map((address) => address.toLowerCase()));
      const marketCandidates = potentialMarketEvidenceAddresses(
        tokensWithMetadata,
        dexScreenerQuotes,
        MARKET_EVIDENCE_LIMIT,
        canonicalAddresses,
      ).flatMap((address) => {
        const dex = dexScreenerQuotes[address];
        return qualifyingMarketEvidencePools(dex).map((poolQuote) => ({ address, dex: poolQuote }));
      });
      const marketEvidenceDiagnosticTargets = [
        "0x696f9436b67233384889472cd7cd58a6fb5df4f1",
        "0x5b2193fdc451c1f847be09ca9d13a4bf60f8c86b",
        "0x1111111111166b7fe7bd91427724b487980afc69",
      ];
      let marketEvidenceTargetTrace: Array<Record<string, unknown>> = [];
      if (import.meta.env.DEV) {
        const qualifiedBeforeLimit = potentialMarketEvidenceAddresses(
          tokensWithMetadata,
          dexScreenerQuotes,
          Number.MAX_SAFE_INTEGER,
          canonicalAddresses,
        );
        marketEvidenceTargetTrace = marketEvidenceDiagnosticTargets.map((address) => {
          const quote = dexScreenerQuotes[address];
          const liquidityOk = Number.isFinite(quote?.liquidityUsd)
            && (quote?.liquidityUsd ?? 0) >= MIN_TRUSTED_LIQUIDITY_USD;
          const volumeOk = Number.isFinite(quote?.volume24hUsd)
            && (quote?.volume24hUsd ?? 0) >= MIN_DEX_VOLUME_24H_USD;
          const tradesPresent = Number.isFinite(quote?.buys24h) && Number.isFinite(quote?.sells24h);
          const buysOk = (quote?.buys24h ?? 0) > 0;
          const sellsOk = (quote?.sells24h ?? 0) > 0;
          const tradesOk = (quote?.buys24h ?? 0) + (quote?.sells24h ?? 0) >= MIN_DEX_TRADES_24H;
          const rank = qualifiedBeforeLimit.indexOf(address);
          const selected = marketCandidates.some((candidate) => candidate.address === address);
          const failedCandidateGates = [
            ...(!quote || quote.source !== "dexscreener" ? ["missing_dexscreener_quote"] : []),
            ...(!liquidityOk ? ["liquidity_below_or_missing_minimum"] : []),
            ...(!volumeOk ? ["volume_below_or_missing_minimum"] : []),
            ...(!tradesPresent ? ["buy_sell_counts_missing_or_invalid"] : []),
            ...(tradesPresent && !buysOk ? ["buys_not_positive"] : []),
            ...(tradesPresent && !sellsOk ? ["sells_not_positive"] : []),
            ...(tradesPresent && buysOk && sellsOk && !tradesOk ? ["total_trades_below_minimum"] : []),
          ];
          const poolCandidateDiagnostics = (quote?.poolCandidates?.length ? quote.poolCandidates : quote ? [quote] : []).map((pool) => {
            const poolTradeCount = (pool.buys24h ?? 0) + (pool.sells24h ?? 0);
            const poolFailures = [
              ...(!pool.poolAddress || !pool.quoteTokenAddress ? ["missing_pool_or_quote_token_address"] : []),
              ...(!Number.isFinite(pool.liquidityUsd) || (pool.liquidityUsd ?? 0) < MIN_TRUSTED_LIQUIDITY_USD ? ["liquidity_below_or_missing_minimum"] : []),
              ...(!Number.isFinite(pool.volume24hUsd) || (pool.volume24hUsd ?? 0) < MIN_DEX_VOLUME_24H_USD ? ["volume_below_or_missing_minimum"] : []),
              ...(!Number.isFinite(pool.buys24h) || !Number.isFinite(pool.sells24h) ? ["buy_sell_counts_missing_or_invalid"] : []),
              ...((pool.buys24h ?? 0) <= 0 ? ["buys_not_positive"] : []),
              ...((pool.sells24h ?? 0) <= 0 ? ["sells_not_positive"] : []),
              ...(poolTradeCount < MIN_DEX_TRADES_24H ? ["total_trades_below_minimum"] : []),
            ];
            return {
              poolAddress: pool.poolAddress ?? null,
              quoteTokenAddress: pool.quoteTokenAddress ?? null,
              priceUsd: pool.priceUsd,
              liquidityUsd: pool.liquidityUsd ?? null,
              volume24hUsd: pool.volume24hUsd ?? null,
              buys24h: pool.buys24h ?? null,
              sells24h: pool.sells24h ?? null,
              qualifiedBeforeTokenLimit: poolFailures.length === 0,
              failedCandidateGates: poolFailures,
            };
          });
          return {
            address,
            dexQuote: quote ? {
              source: quote.source,
              priceUsd: quote.priceUsd,
              liquidityUsd: quote.liquidityUsd ?? null,
              volume24hUsd: quote.volume24hUsd ?? null,
              buys24h: quote.buys24h ?? null,
              sells24h: quote.sells24h ?? null,
              poolAddress: quote.poolAddress ?? null,
              quoteTokenAddress: quote.quoteTokenAddress ?? null,
            } : null,
            candidateGates: {
              liquidityOk,
              volumeOk,
              tradeCountsPresent: tradesPresent,
              buysOk,
              sellsOk,
              tradesOk,
              failedCandidateGates,
            },
            poolCandidateDiagnostics,
            qualifiedBeforeLimit: rank >= 0,
            qualifyingRank: rank >= 0 ? rank + 1 : null,
            marketEvidenceLimit: MARKET_EVIDENCE_LIMIT,
            selectedForEvidence: selected,
            exclusionReason: selected
              ? null
              : failedCandidateGates[0]
                ?? (rank >= MARKET_EVIDENCE_LIMIT ? "outside_market_evidence_limit" : "missing_pool_address_or_canonical_exclusion"),
          };
        });
      }
      const geckoMetrics = createProviderRequestMetrics();
      const marketEvidenceStartedAt = performance.now();
      const geckoEvidence = await fetchGeckoMarketEvidenceDetailed(
        marketCandidates.map(({ address, dex }) => ({ tokenAddress: address, poolAddress: dex.poolAddress! })),
        (url, timeoutMs) => measureProviderRequest(geckoMetrics, () => axios.get(url, { timeout: timeoutMs })),
        marketEvidenceCache,
        // GeckoTerminal is limited to 10 calls/minute, including across scans.
        acquireGeckoRequestSlot,
      );
      const geckoUncachedPoolCount = Object.values(geckoEvidence.diagnostics).filter((diagnostic) => diagnostic.status !== "cached").length;
      geckoMetrics.retryRequestCount = Math.max(0, geckoMetrics.requestCount - Math.ceil(geckoUncachedPoolCount / MARKET_EVIDENCE_LIMIT));
      if (import.meta.env.DEV) {
        console.info("[Clean Dust] market evidence target trace", marketEvidenceTargetTrace.map((target) => {
          const address = String(target.address);
          return {
            ...target,
            poolResults: marketCandidates.filter((candidate) => candidate.address === address).map(({ dex }) => {
              const key = marketEvidencePoolKey(address, dex.poolAddress ?? "");
              return {
                poolAddress: dex.poolAddress,
                gecko: geckoEvidence.diagnostics[key] ?? { status: "not_requested" },
              };
            }),
          };
        }));
      }
      const poolIdentityStartedAt = performance.now();
      let poolIdentityRpcReadCount = publicClient ? 1 : 0; // Includes getChainId when a client is available.
      const poolIdentities = new Map<string, PoolIdentity>();
      let evidenceChainId: number | undefined;
      try { evidenceChainId = publicClient ? await publicClient.getChainId() : undefined; } catch { /* fail closed */ }
      if (publicClient && evidenceChainId === 8453) {
        const poolResults = await Promise.all(marketCandidates.map(async ({ address, dex }) => {
          if (!dex.poolAddress || !dex.quoteTokenAddress) return undefined;
          try {
            const poolAbi = [
              { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
              { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
            ] as const;
            const [token0, token1] = await Promise.all([
              (poolIdentityRpcReadCount += 1, (publicClient as any).readContract({ address: dex.poolAddress as Address, abi: poolAbi, functionName: "token0" })),
              (poolIdentityRpcReadCount += 1, (publicClient as any).readContract({ address: dex.poolAddress as Address, abi: poolAbi, functionName: "token1" })),
            ]);
            return [marketEvidencePoolKey(address, dex.poolAddress), { chainId: evidenceChainId!, token0: String(token0), token1: String(token1), verified: true } as PoolIdentity] as const;
          } catch { return undefined; }
        }));
        for (const result of poolResults) if (result) poolIdentities.set(result[0], result[1]);
      }
      const poolIdentityDurationMs = performance.now() - poolIdentityStartedAt;
      const goPlusMetrics = createProviderRequestMetrics();
      const goPlusRequestsByToken = new Map<string, number>();
      const risks = await Promise.all([...new Set(marketCandidates.map(({ address }) => address))].map(async (address) => [address, await fetchGoPlusRisk(
        address,
        (url, timeoutMs) => {
          const requestCountForToken = goPlusRequestsByToken.get(address) ?? 0;
          goPlusRequestsByToken.set(address, requestCountForToken + 1);
          return measureProviderRequest(goPlusMetrics, () => axios.get(url, { timeout: timeoutMs }), requestCountForToken > 0);
        },
        marketEvidenceCache,
        acquireGoPlusRequestSlot,
      )] as const));
      const riskByAddress = new Map(risks);
      const marketEligibility = new Map<string, ReturnType<typeof evaluateCleanDustEligibility>>();
      const poolEligibility = new Map<string, ReturnType<typeof evaluateCleanDustEligibility>>();
      for (const { address, dex } of marketCandidates) {
        const evidenceKey = marketEvidencePoolKey(address, dex.poolAddress ?? "");
        const eligibility = evaluateCleanDustEligibility({
          address,
          canonicalAddresses: Object.keys(LOCAL_KNOWN_PRICES),
          dex,
          gecko: geckoEvidence.quotes[evidenceKey],
          pool: poolIdentities.get(evidenceKey),
          risk: riskByAddress.get(address),
        });
        poolEligibility.set(evidenceKey, eligibility);
        const existing = marketEligibility.get(address);
        if (!existing || eligibility.eligible) marketEligibility.set(address, eligibility);
        if (eligibility.eligible) {
          quotes[address] = { ...dex, source: "corroborated_market", verified: true };
        }
      }
      const goPlusDiagnosticAggregate = summarizeGoPlusDiagnostics(riskByAddress.values());
      const goPlusTokensWithRequests = goPlusRequestsByToken.size;
      if (import.meta.env.DEV) {
        const poolReasonCounts = [...poolEligibility.values()].reduce<Record<string, number>>((counts, result) => {
          counts[result.reason] = (counts[result.reason] ?? 0) + 1;
          return counts;
        }, {});
        const tokenReasonCounts = [...marketEligibility.values()].reduce<Record<string, number>>((counts, result) => {
          counts[result.reason] = (counts[result.reason] ?? 0) + 1;
          return counts;
        }, {});
        const geckoDiagnosticCounts = Object.values(geckoEvidence.diagnostics).reduce<Record<string, number>>((counts, result) => {
          counts[result.status] = (counts[result.status] ?? 0) + 1;
          return counts;
        }, {});
        console.info("[Clean Dust] market evidence evaluation", {
          poolCandidateCount: marketCandidates.length,
          tokenCount: marketEligibility.size,
          eligibleTokenCount: [...marketEligibility.values()].filter((result) => result.eligible).length,
          poolReasonCounts,
          tokenReasonCounts,
          geckoDiagnosticCounts,
          goPlusDiagnosticAggregate,
          targetPools: marketCandidates.filter(({ address }) => marketEvidenceDiagnosticTargets.includes(address)).map(({ address, dex }) => {
            const key = marketEvidencePoolKey(address, dex.poolAddress ?? "");
            return {
              address,
              poolAddress: dex.poolAddress,
              gecko: geckoEvidence.diagnostics[key] ?? { status: "not_requested" },
              rpcPoolVerified: Boolean(poolIdentities.get(key)?.verified),
              eligibilityReason: poolEligibility.get(key)?.reason ?? "not_evaluated",
            };
          }),
        });
      }
      const priceEvidenceDurationMs = performance.now() - priceEvidenceStartedAt;
      const marketEvidenceDurationMs = performance.now() - marketEvidenceStartedAt;
      if (import.meta.env.DEV) {
        console.info("[Clean Dust] price/evidence performance", {
          clock: "performance.now",
          dexScreener: {
            requestCount: dexScreenerMetrics.requestCount,
            failedRequestCount: dexScreenerMetrics.failedRequestCount,
            requestDurationMs: roundedDurationMs(dexScreenerMetrics.requestDurationMs),
          },
          geckoTerminal: {
            poolCandidateCount: marketCandidates.length,
            cacheHitPoolCount: Object.values(geckoEvidence.diagnostics).filter((diagnostic) => diagnostic.status === "cached").length,
            requestCount: geckoMetrics.requestCount,
            retryRequestCount: geckoMetrics.retryRequestCount,
            failedRequestCount: geckoMetrics.failedRequestCount,
            requestDurationMs: roundedDurationMs(geckoMetrics.requestDurationMs),
          },
          poolIdentityRpc: {
            candidatePoolCount: marketCandidates.length,
            readRequestCount: poolIdentityRpcReadCount,
            verifiedPoolCount: poolIdentities.size,
            durationMs: roundedDurationMs(poolIdentityDurationMs),
          },
          goPlus: {
            tokenLookupCount: riskByAddress.size,
            cachedResultCount: Math.max(0, riskByAddress.size - goPlusTokensWithRequests),
            requestCount: goPlusMetrics.requestCount,
            retryRequestCount: goPlusMetrics.retryRequestCount,
            failedRequestCount: goPlusMetrics.failedRequestCount,
            requestDurationMs: roundedDurationMs(goPlusMetrics.requestDurationMs),
            diagnosticAggregate: goPlusDiagnosticAggregate,
          },
          totalMarketEvidenceEvaluationMs: roundedDurationMs(marketEvidenceDurationMs),
          totalPriceEvidencePipelineMs: roundedDurationMs(priceEvidenceDurationMs),
        });
      }
      addLog(`MARKET EVIDENCE: ${marketCandidates.length} POOLS ACROSS ${marketEligibility.size} TOKENS CHECKED; ${[...marketEligibility.values()].filter((item) => item.eligible).length} TOKENS PASSED; REMAINING EVIDENCE UNAVAILABLE OR INCOMPLETE.`);
      console.timeEnd("⏱️ PRICE FETCH");

      addLog(`CALCULATING VALUES FOR ${tokensWithMetadata.length} ASSETS...`);
      const results: TokenInfo[] = [];
      for (let i = 0; i < tokensWithMetadata.length; i++) {
        const t = tokensWithMetadata[i];
        const balance = balancesWithMetadata[i];
        const formatted = formatUnits(balance, t.decimals);
        const addrLower = t.address?.toLowerCase();

        if (!addrLower) continue;

        // ❌ Ignore WETH from dust detection
        if (addrLower === WETH.toLowerCase()) continue;

        const eligibility = marketEligibility.get(addrLower) ?? evaluateCleanDustEligibility({
          address: t.address,
          canonicalAddresses: Object.keys(LOCAL_KNOWN_PRICES),
        });
        const quote = quotes[addrLower] || dexScreenerQuotes[addrLower];
        const price = quote?.priceUsd || 0;
        const valueUsd = (parseFloat(formatted) || 0) * price;

        if (balance > 0n) {
          results.push({
            ...t,
            balance,
            formattedBalance: formatted,
            priceUsd: price,
            valueUsd,
            priceAcceptedForDust: quote?.verified === true,
            isVerified: quote?.verified === true,
            isEligible: eligibility.eligible,
            eligibilityReason: eligibility.reason,
            priceSource: quote?.source,
            priceEvidenceStatus: quote?.source === "local"
              ? "locally_configured"
              : quote?.source === "corroborated_market"
                ? "market_corroborated"
                : quote ? "indicative" : "unavailable",
            selected: isInitiallySelectedDust({
              address: t.address,
              symbol: t.symbol,
              decimals: t.decimals,
              balance,
              formattedBalance: formatted,
              priceUsd: price,
              valueUsd,
              priceAcceptedForDust: quote?.verified === true,
              priceSource: quote?.source,
              priceEvidenceStatus: quote?.source === "local"
                ? "locally_configured"
                : quote?.source === "corroborated_market"
                  ? "market_corroborated"
                  : quote ? "indicative" : "unavailable",
              isVerified: quote?.verified === true,
              isEligible: eligibility.eligible,
              eligibilityReason: eligibility.reason,
            }, dustThreshold),
          });
        }
      }

      addLog(`SORTING ${results.length} ASSETS...`);
      if (import.meta.env.DEV) {
        const diagnosis = diagnoseCleanDustScan(
          tokensWithBalance.length,
          tokensWithMetadata.length,
          results,
          dustThreshold,
        );
        // Keep wallet-wide token addresses out of diagnostic output. These
        // aggregates plus the three requested address records are sufficient.
        console.info("[Clean Dust] scan diagnosis", {
          ...diagnosis,
          rejectedTokens: `[${diagnosis.rejectedTokens.length} token records omitted]`,
        });
        const diagnosticTargets = [
          "0x696f9436b67233384889472cd7cd58a6fb5df4f1",
          "0x5b2193fdc451c1f847be09ca9d13a4bf60f8c86b",
          "0x1111111111166b7fe7bd91427724b487980afc69",
        ];
        const targetRecords = diagnosticTargets.map((targetAddress) => {
          const token = results.find((candidate) => candidate.address.toLowerCase() === targetAddress);
          if (!token) {
            const metadataIndex = tokensWithMetadata.findIndex((candidate) => candidate.address.toLowerCase() === targetAddress);
            const metadata = metadataIndex >= 0 ? tokensWithMetadata[metadataIndex] : undefined;
            const rawBalance = metadataIndex >= 0 ? balancesWithMetadata[metadataIndex] : undefined;
            const quote = quotes[targetAddress] || dexScreenerQuotes[targetAddress];
            const formattedBalance = metadata && rawBalance !== undefined
              ? formatUnits(rawBalance, metadata.decimals)
              : null;
            return {
              address: targetAddress,
              symbol: metadata?.symbol ?? null,
              decimals: metadata?.decimals ?? null,
              rawBalance: rawBalance?.toString() ?? null,
              formattedBalance,
              priceUsd: quote?.priceUsd ?? null,
              valueUsd: formattedBalance === null || !quote
                ? null
                : (parseFloat(formattedBalance) || 0) * quote.priceUsd,
              priceSource: quote?.source ?? null,
              dustThresholdResult: null,
              eligibility: marketEligibility.get(targetAddress) ?? null,
              priceEvidenceStatus: quote?.source === "local"
                ? "locally_configured"
                : quote?.source === "corroborated_market"
                  ? "market_corroborated"
                  : quote ? "indicative" : "unavailable",
              priceAcceptedForDust: quote?.verified === true,
              executionPriceVerified: false,
              executionQuoteStatus: "not_requested_during_scan",
              marketEvidence: marketEligibility.get(targetAddress) ?? null,
              dexScreenerEvidence: dexScreenerQuotes[targetAddress] ?? null,
              geckoEvidence: marketCandidates.filter((candidate) => candidate.address === targetAddress).map((candidate) => {
                const key = marketEvidencePoolKey(targetAddress, candidate.dex.poolAddress ?? "");
                return { poolAddress: candidate.dex.poolAddress, evidence: geckoEvidence.quotes[key] ?? null, diagnostic: geckoEvidence.diagnostics[key] ?? null };
              }),
              poolIdentity: marketCandidates.filter((candidate) => candidate.address === targetAddress).map((candidate) => poolIdentities.get(marketEvidencePoolKey(targetAddress, candidate.dex.poolAddress ?? "")) ?? null),
              riskEvidence: riskByAddress.get(targetAddress) ?? null,
              included: false,
              rejectionReasons: null,
              stage: "not_present_in_positive_balance_results",
            };
          }
          const tokenAddress = token.address.toLowerCase();
          const tokenDiagnosis = diagnoseDustToken(token, dustThreshold);
          const quote = quotes[tokenAddress] || dexScreenerQuotes[tokenAddress];
          return {
            ...tokenDiagnosis,
            rawBalance: token.balance.toString(),
            decimals: token.decimals,
            selected: token.selected,
            stage: "diagnosed",
            marketEvidence: marketEligibility.get(tokenAddress) ?? null,
            dexScreenerEvidence: dexScreenerQuotes[tokenAddress] ?? null,
            geckoEvidence: marketCandidates.filter((candidate) => candidate.address === tokenAddress).map((candidate) => {
              const key = marketEvidencePoolKey(tokenAddress, candidate.dex.poolAddress ?? "");
              return { poolAddress: candidate.dex.poolAddress, evidence: geckoEvidence.quotes[key] ?? null, diagnostic: geckoEvidence.diagnostics[key] ?? null };
            }),
            poolIdentity: marketCandidates.filter((candidate) => candidate.address === tokenAddress).map((candidate) => poolIdentities.get(marketEvidencePoolKey(tokenAddress, candidate.dex.poolAddress ?? "")) ?? null),
            riskEvidence: riskByAddress.get(tokenAddress) ?? null,
            priceEvidenceStatus: token.priceEvidenceStatus,
            priceAcceptedForDust: token.isVerified,
            scanPrice: quote
              ? { source: quote.source, status: token.priceEvidenceStatus, acceptedForDust: token.isVerified }
              : { status: "unavailable", acceptedForDust: false },
            executionPriceVerified: false,
            executionQuoteStatus: "not_requested_during_scan",
          };
        });
        const targetDiagnosticPayload = {
          dustThresholdUsd: dustThreshold,
          aggregateCounts: {
            positiveVerifiedBalance: diagnosis.positiveVerifiedBalance,
            validMetadata: diagnosis.validMetadata,
            priceAvailable: diagnosis.priceAvailable,
            locallyConfiguredPrice: diagnosis.locallyConfiguredPrice,
            marketCorroboratedPrice: diagnosis.marketCorroboratedPrice,
            indicativePrice: diagnosis.indicativePrice,
            withinDustThreshold: diagnosis.withinDustThreshold,
            eligible: diagnosis.eligible,
            priceAcceptedForDust: diagnosis.priceAcceptedForDust,
            executionPriceVerified: diagnosis.executionPriceVerified,
            executionQuoteStatus: diagnosis.executionQuoteStatus,
            detectedDust: diagnosis.detectedDust,
            rejectedTokenCount: diagnosis.rejectedTokens.length,
            evaluatedRecords: diagnosis.evaluatedRecords,
            primaryOutcomeCounts: diagnosis.primaryOutcomeCounts,
            independentRejectionReasonCounts: diagnosis.independentRejectionReasonCounts,
          },
          targetRecords,
          targetTokensPassingAllChecks: targetRecords
            .filter((token) => token.included)
            .map(({ address, symbol, valueUsd }) => ({ address, symbol, valueUsd })),
        };
        console.info("[Clean Dust] target token diagnostics", targetDiagnosticPayload);
        console.info(
          "[Clean Dust] target token diagnostics JSON",
          JSON.stringify(targetDiagnosticPayload, null, 2),
        );
      }
      results.sort((a, b) => {
        if (Math.abs(b.valueUsd - a.valueUsd) > 0.0001) {
          return b.valueUsd - a.valueUsd;
        }
        return a.symbol.localeCompare(b.symbol);
      });

      setTokens(results);
      if (lifiLogoPromise) {
        void lifiLogoPromise.then((lifiLogos) => {
          setTokens((current) => {
            const updated = current.map((token) => {
              if (usableTokenLogoUrl(token.logoURI)) return token;
              const logoURI = lifiLogos[tokenLogoKey(base.id, token.address)];
              return logoURI ? { ...token, logoURI } : token;
            });
            if (import.meta.env.DEV) {
              console.info("[Token logos] Dust rows", {
                chainId: base.id,
                positiveBalanceTokenCount: updated.length,
                matchedLogoCount: updated.filter((token) => usableTokenLogoUrl(token.logoURI)).length,
                source: "Blockscout plus LI.FI address metadata",
              });
            }
            return updated;
          });
        });
      }
      addLog(discoveryIncomplete
        ? `SCAN PARTIAL: FOUND ${results.length} ASSETS`
        : `SCAN COMPLETE: FOUND ${results.length} ASSETS`);
      });
    } catch (err: any) {
      console.error("Analysis failed", err instanceof Error ? err.name : "unknown_error");
      const errorMsg =
        err.response?.data?.message || err.message || "NETWORK ERROR";
      addLog(`ERROR: ${errorMsg.toUpperCase()}`);
    } finally {
      setIsAnalyzing(false);
    }
    } finally {
      scanRunGuardRef.current.release();
    }
  };

  const addCustomToken = async () => {
    if (!customAddress.startsWith("0x") || customAddress.length !== 42) {
      alert("Invalid address format");
      return;
    }
    setIsAddingCustom(true);
    try {
      const contract = getContract({
        address: customAddress as Address,
        abi: ERC20_ABI,
        client: publicClient as any,
      });

      const [symbol, decimals, balance] = await Promise.all([
        (contract as any).read.symbol(),
        (contract as any).read.decimals(),
        (contract as any).read.balanceOf([address as Address]),
      ]);

      const canonicalPrice = LOCAL_KNOWN_PRICES[customAddress.toLowerCase()];
      const indicativePrice = canonicalPrice ? 0 : (await axios.get(
        `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${customAddress.toLowerCase()}&vs_currencies=usd`,
      )).data[customAddress.toLowerCase()]?.usd || 0;
      const manualQuote = manualTokenPriceQuote(customAddress, indicativePrice, LOCAL_KNOWN_PRICES);
      const price = manualQuote?.priceUsd ?? 0;
      const formatted = formatUnits(balance as bigint, decimals as number);
      const valueUsd = parseFloat(formatted) * price;

      const eligibility = evaluateCleanDustEligibility({
        address: customAddress,
        canonicalAddresses: Object.keys(LOCAL_KNOWN_PRICES),
      });
        const newToken: TokenInfo = {
        symbol: symbol as string,
        address: customAddress as Address,
        decimals: decimals as number,
        balance: balance as bigint,
        formattedBalance: formatted,
        priceUsd: price,
        valueUsd,
        priceSource: manualQuote?.source,
        priceAcceptedForDust: eligibility.eligible && manualQuote?.verified === true,
        isVerified: eligibility.eligible && manualQuote?.verified === true,
        priceEvidenceStatus: manualQuote?.source === "local" ? "locally_configured" : price ? "indicative" : "unavailable",
        // A manually entered address has no Blockscout evidence in this flow.
        // Only a canonical contract can be selected here; other tokens must be
        // discovered by the scanner and meet the same evidence rules as every
        // other Clean Dust candidate.
        isEligible: eligibility.eligible,
        selected: eligibility.eligible && manualQuote?.verified === true,
      };

      setTokens((prev) => {
        const filtered = prev.filter(
          (t) => t.address?.toLowerCase() !== customAddress.toLowerCase(),
        );
        return [newToken, ...filtered];
      });
      setCustomAddress("");
      addLog(`ADDED CUSTOM TOKEN: ${symbol}`);
    } catch (err) {
      console.error("Manual token addition failed", err instanceof Error ? err.name : "unknown_error");
      alert("Failed to fetch token info. Ensure it's a valid ERC20 on Base.");
    } finally {
      setIsAddingCustom(false);
    }
  };

  const toggleSelect = (addr: Address) => {
    setTokens((prev) =>
      prev.map((t) =>
        t.address === addr && t.isEligible ? { ...t, selected: !t.selected } : t,
      ),
    );
  };

  const toggleAll = () => {
    const allSelected =
      filteredTokens.length > 0 && filteredTokens.every((t) => t.selected);
    setTokens((prev) =>
      prev.map((t) => {
        const isFiltered = filteredTokens.some(
          (ft) => ft.address === t.address,
        );
        if (isFiltered && t.isEligible) return { ...t, selected: !allSelected };
        return t;
      }),
    );
  };

  const filteredTokens = useMemo(() => {
    if (showAll) return tokens;
    return tokens.filter((token) => isDetectedDust(token, dustThreshold));
  }, [tokens, showAll, dustThreshold]);

  const totalValueUsd = useMemo(
    () =>
      filteredTokens
        .filter((t) => t.selected)
        .reduce((acc, t) => acc + (t.valueUsd || 0), 0),
    [filteredTokens],
  );

  const unpricedCount = useMemo(
    () => filteredTokens.filter((t) => t.selected && !t.priceUsd).length,
    [filteredTokens],
  );

  return (
    <div className="space-y-8">
      {/* Machine Head */}
      <div className="relative bg-zinc-900 border border-zinc-800 rounded-3xl p-8 overflow-hidden shadow-2xl">
        <div className="absolute top-0 right-0 p-4 opacity-10">
          <Gear className="scale-[4]" speed={20} />
        </div>

        <div className="relative z-10 flex flex-col md:flex-row items-center gap-8">
          <div className="flex-1 space-y-4 text-center md:text-left">
            <h2 className="text-3xl font-black uppercase italic tracking-tighter">
              AI <span className="text-emerald-500">DUST ENGINE</span>
            </h2>
            <p className="text-zinc-400 max-w-md">
              Detects tiny token balances across your wallet and transforms them
              into usable assets using smart routing and real-time market data.
            </p>
            <div className="flex gap-2 pt-2">
              <span className="px-2 py-0.5 bg-zinc-800 text-[10px] font-mono text-emerald-400 rounded">
                ⚡ AI Scan
              </span>
              <span className="px-2 py-0.5 bg-zinc-800 text-[10px] font-mono text-emerald-400 rounded">
                🔄 Smart Conversion
              </span>
              <span className="px-2 py-0.5 bg-zinc-800 text-[10px] font-mono text-emerald-400 rounded">
                🧹 Wallet Cleanup
              </span>
            </div>

            {!isConnected ? (
              <div className="pt-4 flex flex-col items-center md:items-start">
                <div className="flex items-center gap-4 mb-4 px-3 py-1.5 bg-zinc-900/50 border border-zinc-800 rounded-lg">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        apiStatus.debank
                          ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                          : "bg-red-500",
                      )}
                    />
                    <span className="text-[9px] font-mono text-zinc-400 uppercase">
                      Debank
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        apiStatus.oneinch
                          ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                          : "bg-red-500",
                      )}
                    />
                    <span className="text-[9px] font-mono text-zinc-400 uppercase">
                      1inch
                    </span>
                  </div>
                </div>
                <p className="text-sm text-zinc-500 mb-4 italic">
                  Connect your wallet to power the engine
                </p>
                <div className="flex justify-center max-w-full overflow-hidden" onClickCapture={() => !isConnected && logWalletDiagnostic("CLEAN_DUST_CONNECTKIT_PROMPT", {
                  status, address, chainId, connectorId: connector?.id, connectorName: connector?.name,
                  activeSection: "clean", environment: isFarcasterMiniApp ? "farcaster-mini-app" : "normal-web",
                })}>
                  <ConnectKitButton />
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-3 px-3 py-1.5 bg-zinc-900/50 border border-zinc-800 rounded-lg">
                    <div className="flex items-center gap-2">
                      <div
                        className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          apiStatus.debank
                            ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                            : "bg-red-500",
                        )}
                      />
                      <span className="text-[9px] font-mono text-zinc-400 uppercase">
                        Debank
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div
                        className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          apiStatus.oneinch
                            ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                            : "bg-red-500",
                        )}
                      />
                      <span className="text-[9px] font-mono text-zinc-400 uppercase">
                        1inch
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-3 justify-center md:justify-start">
                  <button
                    onClick={() => analyze()}
                    disabled={isAnalyzing}
                    className="group relative px-8 py-3 bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 text-zinc-950 font-bold rounded-xl transition-all active:scale-95 overflow-hidden"
                  >
                    <span className="relative z-10 flex items-center gap-2">
                      {isAnalyzing ? (
                        <RefreshCw className="animate-spin" size={18} />
                      ) : (
                        <Zap size={18} />
                      )}
                      {isAnalyzing ? "ANALYZING..." : "START ENGINE"}
                    </span>
                    <motion.div
                      className="absolute inset-0 bg-white/20"
                      initial={{ x: "-100%" }}
                      whileHover={{ x: "100%" }}
                      transition={{ duration: 0.5 }}
                    />
                  </button>

                  <div className="flex flex-col gap-1 px-4 py-2 bg-zinc-950 border border-zinc-800 rounded-xl min-w-[160px]">
                    <div className="flex justify-between items-center">
                      <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-tighter">
                        Dust Threshold
                      </span>
                      <span className="text-[10px] font-mono text-emerald-500">
                        ${dustThreshold.toFixed(2)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.01"
                      max="5.0"
                      step="0.01"
                      value={dustThreshold}
                      onChange={(e) =>
                        setDustThreshold(parseFloat(e.target.value))
                      }
                      className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                    />
                  </div>

                  <div className="flex items-center gap-2 px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl">
                    <div className="flex -space-x-1">
                      <div className="w-4 h-4 rounded-full bg-emerald-500/20 border border-emerald-500/50 flex items-center justify-center text-[6px] font-bold text-emerald-500">
                        1i
                      </div>
                      <div className="w-4 h-4 rounded-full bg-blue-500/20 border border-blue-500/50 flex items-center justify-center text-[6px] font-bold text-blue-500">
                        Ae
                      </div>
                      <div className="w-4 h-4 rounded-full bg-pink-500/20 border border-pink-500/50 flex items-center justify-center text-[6px] font-bold text-pink-500">
                        Un
                      </div>
                    </div>
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">
                      1inch Aggregator Active
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Wallet Scan */}
            <div className="flex items-center gap-2 pt-2 opacity-60 hover:opacity-100 transition-opacity">
              <div className="relative flex-1 max-w-xs">
                <input
                  type="text"
                  placeholder="Enter wallet address (0x...)"
                  value={scanAddress}
                  onChange={(e) => setScanAddress(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-[10px] font-mono focus:outline-none focus:border-emerald-500/50"
                />
              </div>
              <button
                onClick={() => analyze(scanAddress)}
                disabled={isAnalyzing || !scanAddress}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg text-[10px] font-bold uppercase tracking-tight transition-colors"
              >
                {isAnalyzing ? "Scanning..." : "Scan Wallet"}
              </button>
            </div>
          </div>

          <div className="w-full max-w-[220px] h-[280px] relative flex flex-col items-center justify-center shrink-0">
            <div className="absolute inset-0 border-4 border-dashed border-zinc-800 rounded-full animate-[spin_20s_linear_infinite]" />
            <div className="relative">
              <Gear
                className={cn(
                  "text-zinc-700",
                  isAnalyzing && "text-emerald-500",
                )}
                speed={isAnalyzing ? 2 : 10}
              />
              <Gear
                className="absolute -top-6 -right-6 scale-75 text-zinc-800"
                speed={isAnalyzing ? 1.5 : 8}
                reverse
              />
              <Gear
                className="absolute -bottom-4 -left-4 scale-50 text-zinc-800"
                speed={isAnalyzing ? 1 : 5}
              />
            </div>

            {/* Mechanical Log Monitor */}
            <div className="absolute bottom-10 w-full max-w-[240px] bg-black/80 border border-zinc-800 rounded p-2 font-mono text-[9px] text-emerald-500/80 shadow-xl overflow-hidden h-16 pointer-events-none">
              <div className="flex justify-between border-b border-zinc-800 pb-1 mb-1 text-[7px] uppercase tracking-widest text-zinc-600">
                <span>System Monitor</span>
                <span className="animate-pulse">ONLINE</span>
              </div>
              <div className="space-y-0.5">
                {log.length > 0 ? (
                  log.map((msg, i) => (
                    <div
                      key={i}
                      className={cn(
                        i === 0 ? "text-emerald-400" : "opacity-50",
                      )}
                    >
                      {`> ${msg}`}
                    </div>
                  ))
                ) : (
                  <div className="opacity-30 italic">WAITING FOR INPUT...</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Results Section */}
      <AnimatePresence mode="wait">
        {tokens.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="space-y-4"
          >
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-2">
              <div className="flex items-center gap-4">
                <h3 className="text-sm font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                  <Trash2 size={14} />{" "}
                  {showAll ? "All Assets" : "Detected Dust"} (
                  {filteredTokens.length})
                </h3>
                <button
                  onClick={() => setShowAll(!showAll)}
                  className={cn(
                    "px-2 py-1 rounded text-[10px] font-bold uppercase transition-all border",
                    showAll
                      ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-500"
                      : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300",
                  )}
                >
                  {showAll ? "Show Dust Only" : "Show All Coins"}
                </button>
                {isAnalyzing && (
                  <div className="flex items-end gap-0.5 h-3">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <motion.div
                        key={i}
                        animate={{ height: [4, 12, 6, 10, 4] }}
                        transition={{
                          duration: 0.5,
                          repeat: Infinity,
                          delay: i * 0.1,
                        }}
                        className="w-1 bg-emerald-500 rounded-full"
                      />
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={toggleAll}
                className="group flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-[10px] font-bold uppercase text-zinc-400 hover:text-emerald-500 hover:border-emerald-500/50 transition-all"
              >
                <div
                  className={cn(
                    "w-3 h-3 rounded border flex items-center justify-center transition-colors",
                    filteredTokens.length > 0 &&
                      filteredTokens.every((t) => t.selected)
                      ? "bg-emerald-500 border-emerald-500 text-zinc-950"
                      : "border-zinc-700",
                  )}
                >
                  {filteredTokens.length > 0 &&
                    filteredTokens.every((t) => t.selected) && (
                      <CheckCircle2 size={10} strokeWidth={4} />
                    )}
                </div>
                {filteredTokens.length > 0 &&
                filteredTokens.every((t) => t.selected)
                  ? "Deselect All"
                  : "Select All"}
              </button>
            </div>

            <div className="grid gap-3">
              {filteredTokens.map((token) => (
                <div key={token.address}>
                  <TokenRow
                    token={token}
                    onToggle={() => toggleSelect(token.address)}
                  />
                </div>
              ))}
            </div>

            {/* Swap Panel */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-6">
              <div className="space-y-1 text-center md:text-left">
                <p className="text-xs text-zinc-500 uppercase font-bold tracking-tighter">
                  Total Compression Value
                </p>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-black text-emerald-500">
                    ${(totalValueUsd || 0).toFixed(4)}
                  </span>
                  <span className="text-sm font-mono text-zinc-400 break-all">
                    ≈ {((totalValueUsd || 0) / 2500).toFixed(6)} ETH
                  </span>
                </div>
                {unpricedCount > 0 && (
                  <p className="text-[10px] text-zinc-500 italic">
                    * {unpricedCount} tokens have unknown market value
                  </p>
                )}
                <p className="text-[10px] text-zinc-600 italic uppercase">
                  Includes 3% protocol fee
                </p>
              </div>

              <SwapButton
                tokens={filteredTokens.filter((t) => t.selected)}
                setTokens={setTokens}
                addLog={addLog}
                isConnected={isConnected}
                setOpen={setOpen}
                isFarcasterMiniApp={isFarcasterMiniApp}
                onSuccess={() => {
                  // This callback is now handled internally in SwapButton for better precision
                  // but we keep it for potential external triggers
                }}
              />
            </div>
          </motion.div>
        )}

        {isConnected && !isAnalyzing && tokens.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12 border-2 border-dashed border-zinc-800 rounded-3xl bg-zinc-900/20"
          >
            <div className="flex justify-center mb-4">
              <div className="relative">
                <Trash2 className="text-zinc-700" size={48} />
                <div className="absolute -top-1 -right-1 w-4 h-4 bg-zinc-800 rounded-full flex items-center justify-center">
                  <Search size={8} className="text-zinc-500" />
                </div>
              </div>
            </div>
            <p className="text-zinc-400 font-bold uppercase tracking-widest mb-2">
              No Dust Detected
            </p>
            <p className="text-zinc-600 text-xs max-w-xs mx-auto italic mb-6">
              The engine scanned {tokens.length} tokens but found no balances
              under $1.
            </p>
            <button
              onClick={analyze}
              className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-colors"
            >
              Re-calibrate Scanner
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TokenRow({
  token,
  onToggle,
}: {
  token: TokenInfo;
  onToggle: () => void;
}) {
  return (
    <div
      onClick={token.isEligible ? onToggle : undefined}
      className={cn(
        "group flex items-center gap-4 p-4 rounded-xl border transition-all",
        token.isEligible ? "cursor-pointer" : "cursor-not-allowed opacity-60",
        token.selected
          ? "bg-emerald-500/5 border-emerald-500/30"
          : "bg-zinc-900/50 border-zinc-800 hover:border-zinc-700",
      )}
    >
      <div
        className={cn(
          "w-6 h-6 rounded-md border flex items-center justify-center transition-colors",
          token.selected
            ? "bg-emerald-500 border-emerald-500 text-zinc-950"
            : "border-zinc-700",
        )}
      >
        {token.selected && <CheckCircle2 size={16} strokeWidth={3} />}
      </div>

      <div className="flex-1 min-w-0 overflow-hidden w-0">
        <div className="flex min-w-0 items-center gap-2">
          <TokenLogo chainId={8453} address={token.address} logoURI={token.logoURI} size="sm" />
          <span className="font-bold text-zinc-100 truncate">
            {token.symbol}
          </span>
          {token.isEligible && (
            <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded uppercase font-bold tracking-tighter shrink-0">
              Eligible
            </span>
          )}
        </div>
        <p className="text-[10px] text-zinc-500 font-mono truncate opacity-60">
          {token.address}
        </p>
      </div>

      <div className="text-right">
        <p className="font-bold text-zinc-200 truncate max-w-[110px] sm:max-w-none">
          {Number(token.formattedBalance).toLocaleString(undefined, {
            maximumFractionDigits: 6,
          })}
        </p>
        <p
          className={cn(
            "text-xs font-medium",
            token.valueUsd > 0 ? "text-emerald-500/80" : "text-zinc-500 italic",
          )}
        >
          {token.valueUsd > 0 ? `Est. $${token.valueUsd.toFixed(4)}` : "Price N/A"}
        </p>
      </div>
    </div>
  );
}

function SwapButton({
  tokens,
  setTokens,
  onSuccess,
  addLog,
  isConnected,
  setOpen,
  isFarcasterMiniApp,
}: {
  tokens: TokenInfo[];
  setTokens: (val: TokenInfo[] | ((prev: TokenInfo[]) => TokenInfo[])) => void;
  onSuccess: () => void;
  addLog: (msg: string) => void;
  isConnected: boolean;
  setOpen: (open: boolean) => void;
  isFarcasterMiniApp: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<
    "idle" | "routing" | "approving" | "swapping" | "cleaning"
  >("idle");
  const [currentSource, setCurrentSource] = useState<string>("");

  const { address, chain, status, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();

  const [showSuccess, setShowSuccess] = useState(false);
  const [successData, setSuccessData] = useState({ count: 0, value: 0 });

  const handleSwap = async (e?: any) => {
    const diagnostic = (event: string, error?: unknown) => logWalletDiagnostic(event, {
      status, address, chainId: chain?.id, connectorId: connector?.id, connectorName: connector?.name,
      activeSection: "clean", environment: isFarcasterMiniApp ? "farcaster-mini-app" : "normal-web",
    }, error === undefined ? { operation: "clean_dust_swap" } : { operation: "clean_dust_swap", ...getWalletErrorDetails(error) });
    console.log("🔥 NEW CODE LOADED");

    console.log("🟢 BUTTON CLICKED");

    console.log("🚀 handleSwap triggered");
    console.log("CLEAN DUST TOKEN COUNT:", tokens.length);


    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!isConnected) {
      diagnostic("CLEAN_DUST_CONNECTKIT_PROMPT");
      setOpen(true);
      return;
    }
    if (tokens.length === 0 || !address) return;
    diagnostic("CLEAN_DUST_OPERATION");

    // Ensure correct chain
    if (chain?.id !== base.id) {
      try {
        addLog("SWITCHING TO BASE NETWORK...");
        await switchChainAsync({ chainId: base.id });
      } catch (err) {
        diagnostic("OPERATION_ERROR", err);
        addLog("FAILED TO SWITCH NETWORK. PLEASE SWITCH TO BASE MANUALLY.");
        return;
      }
    }

    setLoading(true);
    setShowSuccess(false); // Reset success state

    try {
      const selectedTokens = tokens.filter((t) => t.selected);

      // 🔥 ADD THIS RIGHT BELOW
      const validTokens = selectedTokens.filter((t) => {
        const balance =
          typeof t.balance === "bigint" ? t.balance : BigInt(t.balance || 0);

        return t.isEligible && t.priceAcceptedForDust && t.valueUsd >= 0.01 && balance > 0n;
      });

      console.log("CLEAN DUST ELIGIBLE TOKEN COUNT:", validTokens.length);

      let successCount = 0;
      let actualSwappedValue = 0;
      const successfulTokenAddresses: string[] = [];
      let verifiedCleanTxHash: string | undefined;

      if (validTokens.length === 0) {
        console.log("❌ NO ELIGIBLE TOKENS SELECTED");
        setLoading(false);
        return;
      }

      // Step 1: Routing via 1inch
      console.log("🚨 ENTERED STEP 1");

      setStep("routing");

      console.log("✅ AFTER setStep routing");

      addLog("QUERYING 1INCH AGGREGATOR...");

      console.log("✅ AFTER addLog");

      await new Promise((r) => setTimeout(r, 1000));

      console.log("✅ AFTER DELAY STEP 1");

      // REAL TRANSACTION FLOW

      // Try EIP-5792 Batching (Smart Wallets like Coinbase)
      let batchSupported = false;

      const isMetaMask = (window as any).ethereum?.isMetaMask;

      if (!isMetaMask) {
        try {
          const capabilities = await (window as any).ethereum?.request({
            method: "wallet_getCapabilities",
            params: [address],
          });

          batchSupported =
            !!capabilities?.[base.id.toString()]?.atomicBatch?.supported;
        } catch (e) {
          console.warn("Batching not supported", e instanceof Error ? e.name : "unknown_error");
        }
      }

      // Fallback to sequential for standard wallets

      // 🔥 NEW: Contract batch arrays
      const tokensArr: string[] = [];
      const amountsArr: bigint[] = [];

      const targetsArr: `0x${string}`[] = [];
      const valuesArr: bigint[] = [];
      const swapDataArr: `0x${string}`[] = [];

      const approvedTokens = new Set<string>(
        JSON.parse(localStorage.getItem(`dustApproved_${address}`) || "[]"),
      );

      const wordPos = 0n;

      const bitmap = await publicClient.readContract({
        address: PERMIT2_ADDRESS,
        abi: PERMIT2_SIGNATURE_ABI,
        functionName: "nonceBitmap",
        args: [address as `0x${string}`, wordPos],
      });

      let nextBitPos = 0n;


      while (nextBitPos < 256n && ((bitmap >> nextBitPos) & 1n) === 1n) {
        nextBitPos++;
      }


      for (const token of validTokens) {
        let amount: bigint;
        console.log("Preparing eligible token swap");
        try {
          addLog(`🔄 Swapping ${token.symbol}...`);
          addLog(`PROCESSING ${token.symbol}...`);

          if (typeof token.balance === "bigint") {
            amount = token.balance;
          } else if (
            typeof token.balance === "string" &&
            token.balance.length > 15 &&
            !token.balance.includes(".")
          ) {
            amount = BigInt(token.balance);
          } else {
            amount = parseUnits(token.balance.toString(), token.decimals);
          }

          console.log("🚨 CHECKPOINT AFTER AMOUNT");

          if (amount <= 0n) {
            console.log("❌ SKIPPED: ZERO AMOUNT");
            continue;
          }

          amount = (amount * 98n) / 100n;
        } catch (e) {
          console.warn("❌ Invalid token balance for swap");
          continue;
        }

        // =====================================
        // PERMIT2 SETUP
        // =====================================

        const allowance = await publicClient.readContract({
          address: token.address,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address as `0x${string}`, PERMIT2_ADDRESS],
        });

        if (
          allowance < amount &&
          !approvedTokens.has(token.address.toLowerCase())
        ) {
          addLog(`APPROVING ${token.symbol}...`);

          const approveHash = await writeContractAsync({
            address: token.address,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [PERMIT2_ADDRESS, maxUint256],
          });

          addLog(`⏳ Waiting approval for ${token.symbol}...`);

          await publicClient.waitForTransactionReceipt({
            hash: approveHash,
          });

          approvedTokens.add(token.address.toLowerCase());

          localStorage.setItem(
            `dustApproved_${address}`,
            JSON.stringify([...approvedTokens]),
          );
        }

        if (amount <= 0n) {
          console.log("❌ Skipping token with invalid amount");
          continue;
        }

        // 2. Real Swap (Attempt via Proxy)
        console.log("🚨 BEFORE SWAP BLOCK");

        try {
          console.log("🚨 ENTERED SWAP BLOCK");

          // 🔥 LIFI ROUTES FETCH (FINAL FIX)
          const WETH = "0x4200000000000000000000000000000000000006";

          let routes;

          try {
            routes = await getRoutes({
              fromChainId: 8453,
              toChainId: 8453,
              fromTokenAddress: token.address,
              toTokenAddress: WETH,
              fromAmount: amount.toString(),

              fromAddress: DUST_ENGINE_ADDRESS,
              toAddress: DUST_ENGINE_ADDRESS,

              options: {
                allowSwitchChain: false,
                skipPermit: true,
              },
            });

          } catch (err) {
            console.warn("LiFi route request failed");
            if (import.meta.env.DEV) console.info("[Clean Dust] route quote diagnostic", { symbol: token.symbol, status: "route_request_failed" });
            addLog(`❌ LiFi failed for ${token.symbol}`);
            continue;
          }

          // ✅ VALIDATE RESPONSE
          if (!routes || !routes.routes?.length) {
            if (import.meta.env.DEV) console.info("[Clean Dust] route quote diagnostic", { symbol: token.symbol, status: "route_unavailable" });
            console.log("❌ No routes found");
            addLog(`❌ No valid route for ${token.symbol}`);
            continue;
          }

          // ✅ EXTRACT ROUTE
          const route = routes.routes[0];
          const step = route.steps?.[0];

          if (!step) {
            if (import.meta.env.DEV) console.info("[Clean Dust] route quote diagnostic", { symbol: token.symbol, status: "route_unavailable" });
            console.log("❌ No step found");
            continue;
          }

          if (step.action.toAddress?.toLowerCase() !== DUST_ENGINE_ADDRESS.toLowerCase()) {
            if (import.meta.env.DEV) console.info("[Clean Dust] route quote diagnostic", { symbol: token.symbol, status: "route_recipient_mismatch" });
            addLog(`❌ Invalid route for ${token.symbol}`);
            continue;
          }

          // 🔥 THIS IS THE MISSING PIECE
          let stepTx;
          try {
            stepTx = await getStepTransaction(step);
          } catch {
            if (import.meta.env.DEV) console.info("[Clean Dust] route quote diagnostic", { symbol: token.symbol, status: "transaction_data_invalid" });
            addLog(`❌ Invalid route for ${token.symbol}`);
            continue;
          }

          const tx = stepTx?.transactionRequest;
          const routeQuoteDiagnostic = diagnoseRouteQuote({
            route,
            step,
            transactionRequest: tx,
            requestedInputAmount: amount.toString(),
            expectedInputToken: token.address,
            expectedOutputToken: WETH,
            expectedRecipient: DUST_ENGINE_ADDRESS,
          });
          if (import.meta.env.DEV) {
            console.info("[Clean Dust] route quote diagnostic", { symbol: token.symbol, ...routeQuoteDiagnostic });
          }
          if (routeQuoteDiagnostic.status !== "route_quote_validated") {
            addLog(`❌ Invalid route for ${token.symbol}`);
            continue;
          }

          // ✅ FINAL VALIDATION
          if (!tx || !tx.to || !tx.data) {
            console.log("❌ Invalid transaction constructed");
            addLog(`❌ Invalid route for ${token.symbol}`);
            continue;
          }


          // ✅ FIX: VALIDATE BLOCK
          if (
            !tx.to ||
            typeof tx.to !== "string" ||
            !tx.to.startsWith("0x") ||
            tx.to.length !== 42
          ) {
            console.log("❌ INVALID tx.to DETECTED");
            addLog(`❌ Invalid route for ${token.symbol}`);
            continue; // 🚨 SKIP THIS TOKEN
          }

          // ✅ REQUIRED ARRAYS FOR CONTRACT
          tokensArr.push(token.address);
          amountsArr.push(amount);


          // ✅ SAFE PUSH
          targetsArr.push(tx.to as `0x${string}`);
          valuesArr.push(BigInt(tx.value || "0"));
          swapDataArr.push(tx.data as `0x${string}`);

          await new Promise((r) => setTimeout(r, 250));
        } catch (err: any) {
          console.warn("❌ SWAP ERROR:", err?.name || "unknown_error");
          addLog(`❌ Swap failed for ${token.symbol}`);
          continue;
        }
      }

      // 🚀 EXECUTE CONTRACT BATCH
      let batchSignature: `0x${string}` | undefined;
      let batchNonce: bigint = 0n;
      let batchDeadline: bigint = 0n;

      if (tokensArr.length > 0) {
        try {
          batchNonce = (wordPos << 8n) | nextBitPos;

          batchDeadline =
            BigInt(
              Math.floor(Date.now() / 1000) + 3600
            );

          const domain = {
            name: "Permit2",
            chainId: 8453,
            verifyingContract: PERMIT2_ADDRESS,
          };

          const types = {
            PermitBatchTransferFrom: [
              {
                name: "permitted",
                type: "TokenPermissions[]",
              },
              {
                name: "spender",
                type: "address",
              },
              {
                name: "nonce",
                type: "uint256",
              },
              {
                name: "deadline",
                type: "uint256",
              },
            ],

            TokenPermissions: [
              {
                name: "token",
                type: "address",
              },
              {
                name: "amount",
                type: "uint256",
              },
            ],
          };

          const message = {
            permitted: tokensArr.map(
              (token, i) => ({
                token,
                amount: amountsArr[i],
              })
            ),

            spender: DUST_ENGINE_ADDRESS,

            nonce: batchNonce,

            deadline: batchDeadline,
          };

          addLog(
            `✍️ Sign one Permit for ${tokensArr.length} tokens...`
          );

          batchSignature =
            await signTypedDataAsync({
              domain,
              types,
              primaryType:
                "PermitBatchTransferFrom",
              message,
            });

          addLog("🚀 Executing via contract...");

          console.info("Transaction batch prepared", { tokenCount: tokensArr.length, targetCount: targetsArr.length, valueCount: valuesArr.length, swapCount: swapDataArr.length });

          try {
            await publicClient.simulateContract({
              address: DUST_ENGINE_ADDRESS,
              abi: DUST_ENGINE_ABI,
              functionName: "cleanDust",
              args: [
                tokensArr,
                amountsArr,
                batchSignature,
                batchNonce,
                batchDeadline,
                targetsArr,
                valuesArr,
                swapDataArr,
              ],
              account: address,
            });

            console.log("SIMULATION OK");
          } catch (e) {
            console.error("SIMULATION ERROR", e instanceof Error ? e.name : "unknown_error");
          
            const bitmapAfter = await publicClient.readContract({
              address: PERMIT2_ADDRESS,
              abi: PERMIT2_SIGNATURE_ABI,
              functionName: "nonceBitmap",
              args: [address as `0x${string}`, 0n],
            });

            console.log("Permit nonce bitmap checked after simulation failure");
            throw new Error("Clean Dust batch simulation failed");

          }

          try {
      
            const hash = await writeContractAsync({
              address: DUST_ENGINE_ADDRESS,
              abi: DUST_ENGINE_ABI,
              functionName: "cleanDust",
              args: [
                tokensArr,
                amountsArr,
                batchSignature,
                batchNonce,
                batchDeadline,
                targetsArr,
                valuesArr,
                swapDataArr,
              ],
            });

            addLog(`📤 TX SENT: ${hash.slice(0, 10)}...`);
            addLog("⏳ Waiting for confirmation...");

            const receipt = await publicClient.waitForTransactionReceipt({
              hash,
            });

            await publicClient.getTransaction({ hash });

            console.log("RECEIPT STATUS:", receipt.status);
            console.log("GAS USED:", receipt.gasUsed?.toString());
            
            const SWAP_FAILED_TOPIC =
              "0xfe6bbaf9875f995c8d6dacfc5247772cf0a90b3efd2b5c71204476c142ce3c4f";

            const DEBUG_TOPIC =
              "0x831cbf9f01add60715b6c2ea1016801f01c3570519cef4de93ce9c722257cca5";

            const swapFailed = receipt.logs.some(
              (log) =>
                log.address.toLowerCase() === DUST_ENGINE_ADDRESS.toLowerCase() &&
                log.topics?.[0]?.toLowerCase() === SWAP_FAILED_TOPIC.toLowerCase()
            );

            const debugSuccess = receipt.logs.some(
              (log) =>
                log.address.toLowerCase() === DUST_ENGINE_ADDRESS.toLowerCase() &&
                log.topics?.[0]?.toLowerCase() === DEBUG_TOPIC.toLowerCase()
            );

            console.log("SWAP FAILED?", swapFailed);
            console.log("DEBUG SUCCESS?", debugSuccess);

            try {
              const decoded = decodeEventLog({
                abi: DUST_ENGINE_ABI,
                data: log.data,
                topics: log.topics,
              });

              console.log("DECODED EVENT:", decoded.eventName);
            } catch (e) {
              console.log("FAILED TO DECODE");
            }


            try {
              const parsedLogs = receipt.logs.map((log) => {
                try {
                  return decodeEventLog({
                    abi: DUST_ENGINE_ABI,
                    data: log.data,
                    topics: log.topics,
                  });
                } catch {
                  return null;
                }
              });


              if (receipt.status === "success") {
                addLog("✅ Compression transaction confirmed");

                const debugResults = parsedLogs.flatMap((log) => {
                  if (!log || log.eventName !== "Debug" || !isObject(log.args)) return [];
                  const token: unknown = Reflect.get(log.args, "token");
                  const success: unknown = Reflect.get(log.args, "success");
                  if (typeof token !== "string" || typeof success !== "boolean") return [];
                  return [{ token: token.toLowerCase(), success }];
                });


                const successfulAddresses = new Set(
                  debugResults
                    .filter((result) => result.success)
                    .map((result) => result.token),
                );

                const successfulTokens =
                  debugResults.length > 0
                    ? validTokens.filter((token) =>
                        successfulAddresses.has(token.address.toLowerCase()),
                      )
                    : validTokens;

                const failedTokens =
                  debugResults.length > 0
                    ? validTokens.filter(
                        (token) => !successfulAddresses.has(token.address.toLowerCase()),
                      )
                    : [];

                console.log("SWAP RESULT COUNTS:", { successful: successfulTokens.length, failed: failedTokens.length });

                successCount = successfulTokens.length;

                actualSwappedValue = successfulTokens.reduce(
                  (acc, token) => acc + (token.valueUsd || 0),
                  0,
                );

                successfulTokenAddresses.push(
                  ...successfulTokens.map((token) => token.address.toLowerCase()),
                );

                if (failedTokens.length > 0) {
                  addLog(
                    `⚠️ ${failedTokens.length} token${
                      failedTokens.length === 1 ? "" : "s"
                    } failed, but successful swaps were completed`,
                  );
                }

                if (successCount > 0) {
                  verifiedCleanTxHash = hash;
                  addLog(
                    `✅ ${successCount} of ${validTokens.length} token${
                      validTokens.length === 1 ? "" : "s"
                    } swapped successfully`,
                  );
                  setStep("success");
                } else {
                  addLog("❌ No tokens were swapped successfully");
                }
              } else {
                console.error("❌ RECEIPT REVERT");
                addLog("❌ Transaction reverted");
              }
            } catch (e) {
              console.error("❌ LOG PROCESSING ERROR:", e instanceof Error ? e.name : "unknown_error");
            }

          } catch (err: any) {
            diagnostic("OPERATION_ERROR", err);
            console.error("❌ WRITE ERROR:", err instanceof Error ? err.name : "unknown_error");
          }
        } catch (err) {
          diagnostic("OPERATION_ERROR", err);
          console.error("❌ Contract failed:", err instanceof Error ? err.name : "unknown_error");

          if (err?.name === "UserRejectedRequestError") {
            addLog("❌ User rejected transaction");
          } else {
            addLog("❌ Contract execution failed");
          }
          setStep("error");
        }
      }

      // Step 4: Cleaning & Fee Distribution
      if (successCount > 0) {
        setStep("cleaning");
        addLog("DISTRIBUTING 3% PROTOCOL FEE...");
        await new Promise((r) => setTimeout(r, 1000));

        addLog("COMPRESSION COMPLETE");

        // Report to backend for analytics
        try {
          await axios.post("/api/report-swap", {
            valueUsd: actualSwappedValue,
          });
        } catch (e) {
          console.warn("Failed to report swap analytics");
        }

        if (verifiedCleanTxHash) {
          void axios.post("/api/achievements/verify-clean", {
            txHash: verifiedCleanTxHash,
          }).catch(() => {
            // Verification is asynchronous and never changes transaction success.
          });
        }

        setSuccessData({ count: successCount, value: actualSwappedValue });
        setShowSuccess(true);

        // Surgically remove only successful tokens
        setTokens((prev) =>
          prev.filter(
            (t) => !successfulTokenAddresses.includes(t.address.toLowerCase()),
          ),
        );
        addLog(`UI UPDATED: ${successCount} ASSETS REMOVED`);
      } else {
        addLog(
          "NO TOKENS WERE SUCCESSFULLY COMPRESSED. CHECK LOGS FOR ERRORS.",
        );
      }
    } catch (err: any) {
      diagnostic("OPERATION_ERROR", err);
      console.error("Clean Dust operation failed", err instanceof Error ? err.name : "unknown_error");
      const errorDetail =
        err.response?.data?.description ||
        err.response?.data?.error ||
        err.shortMessage ||
        err.message;
      addLog(`ERROR: ${errorDetail || "ROUTER FAILURE"}`);
    } finally {
      setLoading(false);
      setStep("idle");
      setCurrentSource("");
    }
  };

  const getLabel = () => {
    switch (step) {
      case "routing":
        return `ROUTING: ${currentSource}...`;
      case "approving":
        return "OILING 1INCH GEARS...";
      case "swapping":
        return "AGGREGATING LIQUIDITY...";
      case "cleaning":
        return "DISTRIBUTING FEES...";
      default:
        return `COMPRESS ${tokens.filter((t) => t.selected).length} TOKENS`;
    }
  };

  return (
    <div className="w-full md:w-auto space-y-4">
      {loading && (
        <div className="bg-zinc-950/50 border border-zinc-800 rounded-xl p-3 flex items-center gap-4 animate-pulse">
          <div className="flex -space-x-2">
            <div className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[8px] font-bold">
              1i
            </div>
            <div className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[8px] font-bold">
              Ae
            </div>
            <div className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[8px] font-bold">
              Un
            </div>
          </div>
          <div className="flex-1">
            <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-emerald-500"
                initial={{ width: "0%" }}
                animate={{ width: "100%" }}
                transition={{ duration: 5, ease: "linear" }}
              />
            </div>
            <p className="text-[10px] text-zinc-500 mt-1 uppercase tracking-tighter font-mono">
              Aggregator Path: Dust → 1inch → {currentSource || "..."} → ETH
            </p>
          </div>
        </div>
      )}

      <button
        onClick={(e) => {
          console.log("🟢 BUTTON CLICKED");
          handleSwap(e);
        }}
        disabled={loading || tokens.filter((t) => t.selected).length === 0}
        type="button"
        className={cn(
          "w-full md:w-auto px-12 py-4 font-black uppercase italic tracking-tighter rounded-xl transition-all active:scale-95 flex items-center justify-center gap-3 shadow-lg relative overflow-hidden",
          loading
            ? "bg-zinc-800 text-emerald-500 cursor-wait"
            : "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-[0_0_20px_rgba(16,185,129,0.3)]",
        )}
      >
        {loading ? (
          <RefreshCw className="animate-spin" size={20} />
        ) : (
          <Zap
            size={20}
            className={
              tokens.filter((t) => t.selected).length > 0 ? "animate-pulse" : ""
            }
          />
        )}
        {getLabel()}

        {/* Batch Mode Badge */}
        {!loading && (
          <div className="absolute top-1 right-2 flex items-center gap-1">
            <div className="w-1 h-1 rounded-full bg-black/40 animate-pulse" />
            <span className="text-[7px] font-bold opacity-40">
              EIP-5792 READY
            </span>
          </div>
        )}
      </button>

      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          >
            <div className="bg-zinc-900 border border-emerald-500/50 rounded-3xl p-8 max-w-sm w-full text-center space-y-6 shadow-[0_0_50px_rgba(16,185,129,0.2)]">
              <div className="w-20 h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto border border-emerald-500/50">
                <CheckCircle2 size={40} className="text-emerald-500" />
              </div>
              <div className="space-y-2">
                <h3 className="text-2xl font-black uppercase italic tracking-tighter">
                  Compression Successful
                </h3>
                <p className="text-zinc-400 text-sm">
                  Successfully compressed {successData.count} tokens into ETH
                  via 1inch Aggregator.
                </p>
                <div className="pt-2 font-mono text-emerald-500 text-lg">
                  +${successData.value.toFixed(4)} Value
                </div>
              </div>
              <button
                onClick={() => {
                  setShowSuccess(false);
                  onSuccess();
                }}
                className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-xl transition-all"
              >
                DISMISS
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
