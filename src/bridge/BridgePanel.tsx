import {
  AlertCircle,
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAccount, useConnection } from "wagmi";
import { useModal } from "connectkit";
import { recordAchievementEvent } from "../achievements/achievementEngine";
import { formatUnits, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import {
  executeRoute,
  getRoutes,
  resumeRoute,
  type ExtendedChain,
  type Process,
  type Route,
  type RouteExtended,
  type Token,
} from "@lifi/sdk";
import {
  BRIDGE_FEE,
  BRIDGE_INTEGRATOR,
  configureBridgeEvmProvider,
  getBridgeTokenBalance,
  getSupportedConnections,
  getSupportedEvmChains,
  getSupportedTokens,
} from "./lifi";

type TokenSelectorProps = {
  address?: Address;
  chainId?: number;
  chains: ExtendedChain[];
  disabled?: boolean;
  label: string;
  onSelect: (token?: Token) => void;
  selectedToken?: Token;
};

const ROUTE_RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type StoredBridgeRoute = {
  walletAddress: string;
  routeId: string;
  route: string;
  fromChainId: number;
  toChainId: number;
  timestamp: number;
};

function routeRecoveryKey(address: Address) {
  return `dustengine:bridge:route:${address.toLowerCase()}`;
}

function isRouteComplete(route: RouteExtended) {
  return route.steps.length > 0 && route.steps.every((step) => step.execution?.status === "DONE");
}

function isStoredBridgeRoute(value: unknown): value is StoredBridgeRoute {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.walletAddress === "string" &&
    typeof record.routeId === "string" &&
    typeof record.route === "string" &&
    typeof record.fromChainId === "number" &&
    typeof record.toChainId === "number" &&
    typeof record.timestamp === "number"
  );
}

function isRestorableRoute(value: unknown): value is RouteExtended {
  if (!value || typeof value !== "object") return false;
  const route = value as Record<string, unknown>;
  return typeof route.id === "string" && Array.isArray(route.steps);
}

function saveRouteRecovery(address: Address, route: RouteExtended) {
  if (isRouteComplete(route)) {
    window.localStorage.removeItem(routeRecoveryKey(address));
    return;
  }

  try {
    const serializedRoute = JSON.stringify(route, (key, value) =>
      /signature|signedtypeddata|privatekey|apikey/i.test(key) ? undefined : value,
    );
    const record: StoredBridgeRoute = {
      walletAddress: address.toLowerCase(),
      routeId: route.id,
      route: serializedRoute,
      fromChainId: route.fromChainId,
      toChainId: route.toChainId,
      timestamp: Date.now(),
    };
    window.localStorage.setItem(routeRecoveryKey(address), JSON.stringify(record));
  } catch {
    // Route recovery is optional; never persist partial or non-serializable state.
  }
}

function tokenAddressLabel(token: Token) {
  if (token.address.toLowerCase() === zeroAddress) return "Native asset";
  return token.address;
}

function isUsableBridgeToken(token: Token, chainId: number) {
  return (
    token.chainId === chainId &&
    isAddress(token.address) &&
    Number.isInteger(token.decimals) &&
    token.decimals >= 0 &&
    token.decimals <= 255 &&
    token.symbol.trim().length > 0 &&
    token.name.trim().length > 0 &&
    !/[\u0000-\u001F\u007F]/.test(token.symbol) &&
    !/[\u0000-\u001F\u007F]/.test(token.name)
  );
}

function tokenInitials(token: Token) {
  return token.symbol.trim().slice(0, 2).toUpperCase();
}

function TokenAvatar({ token, size = "md" }: { token: Token; size?: "sm" | "md" }) {
  const [hasImageError, setHasImageError] = useState(false);
  const logoUri = token.logoURI?.trim();
  const hasLogo = Boolean(logoUri && /^https?:\/\//i.test(logoUri) && !hasImageError);
  const sizeClass = size === "sm" ? "h-9 w-9 text-[10px]" : "h-11 w-11 text-xs";

  if (hasLogo) {
    return (
      <img
        src={logoUri}
        alt=""
        onError={() => setHasImageError(true)}
        className={`${sizeClass} shrink-0 rounded-full border border-zinc-700/80 bg-zinc-900 object-cover`}
      />
    );
  }

  return (
    <span className={`${sizeClass} flex shrink-0 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10 font-mono font-bold text-emerald-300`}>
      {tokenInitials(token)}
    </span>
  );
}

function formatWalletBalance(balance: bigint | undefined, token: Token) {
  if (balance === undefined) return "—";
  try {
    return Number(formatUnits(balance, token.decimals)).toLocaleString(undefined, {
      maximumFractionDigits: 6,
    });
  } catch {
    return "—";
  }
}

function TokenPicker({
  address,
  chainId,
  chains,
  disabled,
  label,
  onSelect,
  selectedToken,
}: TokenSelectorProps) {
  const [query, setQuery] = useState("");
  const [tokens, setTokens] = useState<Token[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [balances, setBalances] = useState<Record<string, bigint>>({});

  useEffect(() => {
    if (!chainId) {
      setTokens([]);
      onSelect(undefined);
      return;
    }

    let isCurrent = true;
    const timeout = window.setTimeout(async () => {
      setIsLoading(true);
      setError("");

      try {
        const nextTokens = (await getSupportedTokens(chainId, query.trim())).filter((token) =>
          isUsableBridgeToken(token, chainId),
        );
        if (!isCurrent) {
          return;
        }

        const selected = nextTokens.find(
          (token) => token.address.toLowerCase() === selectedToken?.address.toLowerCase(),
        );
        const visibleTokens = selectedToken && isUsableBridgeToken(selectedToken, chainId) && !selected
          ? [selectedToken, ...nextTokens]
          : nextTokens;
        setTokens(visibleTokens);
        if (selected) onSelect(selected);
        if (!selectedToken && !query.trim()) onSelect(nextTokens[0]);
      } catch (err) {
        if (isCurrent) {
          setTokens([]);
          onSelect(undefined);
          setError(err instanceof Error ? err.message : "Unable to load tokens.");
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    }, 250);

    return () => {
      isCurrent = false;
      window.clearTimeout(timeout);
    };
  }, [chainId, onSelect, query, selectedToken?.address]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen]);

  useEffect(() => {
    setBalances({});
  }, [address, chainId]);

  const balanceTargets = useMemo(() => {
    const visibleTokens = isOpen ? tokens.slice(0, 24) : [];
    if (selectedToken && !visibleTokens.some((token) => token.address === selectedToken.address)) {
      visibleTokens.unshift(selectedToken);
    }
    return visibleTokens;
  }, [isOpen, selectedToken, tokens]);

  useEffect(() => {
    if (!address || !chainId || chains.length === 0 || balanceTargets.length === 0) return;
    let isCurrent = true;
    const missingTokens = balanceTargets.filter((token) => balances[token.address.toLowerCase()] === undefined);
    if (missingTokens.length === 0) return;

    void Promise.allSettled(
      missingTokens.map(async (token) => ({
        key: token.address.toLowerCase(),
        balance: await getBridgeTokenBalance({ address, chainId, chains, token }),
      })),
    ).then((results) => {
      if (!isCurrent) return;
      setBalances((current) => {
        const next = { ...current };
        for (const result of results) {
          if (result.status === "fulfilled") next[result.value.key] = result.value.balance;
        }
        return next;
      });
    });

    return () => {
      isCurrent = false;
    };
  }, [address, balanceTargets, balances, chainId, chains]);

  const selectToken = (token: Token) => {
    onSelect(token);
    setIsOpen(false);
    setQuery("");
  };

  const selectedBalance = selectedToken
    ? balances[selectedToken.address.toLowerCase()]
    : undefined;

  return (
    <div className="block">
      <span className="mb-2 block text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-zinc-500">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        disabled={!chainId || disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className="flex min-h-16 w-full items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-950 px-3.5 py-3 text-left transition-colors hover:border-emerald-500/40 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {selectedToken ? (
          <span className="flex min-w-0 items-center gap-3">
            <TokenAvatar token={selectedToken} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold text-zinc-100">{selectedToken.symbol}</span>
              <span className="block truncate text-xs text-zinc-500">{selectedToken.name}</span>
            </span>
          </span>
        ) : (
          <span className="text-sm text-zinc-500">{isLoading ? "Loading LI.FI tokens…" : "Select token"}</span>
        )}
        <span className="flex shrink-0 flex-col items-end gap-1">
          {address && selectedToken && <span className="text-xs font-mono text-zinc-400">{formatWalletBalance(selectedBalance, selectedToken)}</span>}
          <ChevronDown size={16} className="text-zinc-500" />
        </span>
      </button>
      {selectedToken && (
        <span className="mt-2 block break-all text-[10px] font-mono text-zinc-500">
          {tokenAddressLabel(selectedToken)} · {selectedToken.decimals} decimals
        </span>
      )}
      <span className="mt-2 block text-[10px] leading-4 text-zinc-600">
        Token metadata is provided by LI.FI. Verify the token contract address independently before bridging.
      </span>
      {error && <span className="mt-2 block text-xs text-rose-400">{error}</span>}
      {isOpen && (
        <div className="fixed inset-0 z-[70] flex items-end bg-black/70 p-3 backdrop-blur-sm sm:items-center sm:justify-center sm:p-6" role="presentation" onMouseDown={() => setIsOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label={`Select ${label.toLowerCase()}`}
            onMouseDown={(event) => event.stopPropagation()}
            className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-zinc-700 bg-zinc-900 shadow-2xl sm:max-h-[min(42rem,calc(100dvh-3rem))]"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
              <div><h3 className="text-base font-black uppercase tracking-wide text-zinc-100">Select token</h3><p className="mt-1 text-xs text-zinc-500">LI.FI-supported assets on this network</p></div>
              <button type="button" onClick={() => setIsOpen(false)} className="rounded-xl p-2 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200" aria-label="Close token picker"><X size={18} /></button>
            </div>
            <div className="border-b border-zinc-800 p-4">
              <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tokens" className="w-full rounded-xl border border-zinc-700 bg-zinc-950 py-3 pl-10 pr-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500/50" /></div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
              {isLoading && <div className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-zinc-500"><Loader2 className="animate-spin" size={17} /> Loading LI.FI tokens…</div>}
              {!isLoading && error && <div className="px-4 py-12 text-center text-sm text-rose-400">{error}</div>}
              {!isLoading && !error && tokens.length === 0 && <div className="px-4 py-12 text-center text-sm text-zinc-500">No supported tokens found.</div>}
              {!isLoading && !error && tokens.map((token) => {
                const isSelected = token.address.toLowerCase() === selectedToken?.address.toLowerCase();
                return <button key={token.address} type="button" onClick={() => selectToken(token)} className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${isSelected ? "bg-emerald-500/10" : "hover:bg-zinc-800"}`}><TokenAvatar token={token} size="sm" /><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><strong className="truncate text-sm text-zinc-100">{token.symbol}</strong>{isSelected && <CheckCircle2 size={14} className="shrink-0 text-emerald-400" />}</span><span className="block truncate text-xs text-zinc-500">{token.name}</span></span>{address && <span className="shrink-0 text-right"><span className="block text-xs font-mono text-zinc-300">{formatWalletBalance(balances[token.address.toLowerCase()], token)}</span><span className="block text-[10px] uppercase tracking-wide text-zinc-600">Balance</span></span>}</button>;
              })}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function formatTokenAmount(amount: string, token: Token) {
  try {
    return Number(formatUnits(BigInt(amount), token.decimals)).toLocaleString(undefined, {
      maximumFractionDigits: 6,
    });
  } catch {
    return amount;
  }
}

function formatDuration(seconds?: number) {
  if (!seconds) return "Not available";
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)} min`;
  return `~${Math.ceil(seconds / 3600)} hr`;
}

function processLabel(process: Process) {
  if (process.status === "DONE") return "Completed";
  if (process.status === "FAILED") return process.error?.message || "Failed";
  if (process.type === "TOKEN_ALLOWANCE" || process.type === "PERMIT") return "Approving token";
  if (process.type === "CROSS_CHAIN") return "Bridging";
  if (process.type === "RECEIVING_CHAIN") return "Receiving on destination";
  if (process.status === "ACTION_REQUIRED") return "Confirm transaction";
  if (process.status === "PENDING") return "Confirming transaction";
  return "Preparing route";
}

function isUserRejection(error: unknown) {
  const candidate = error as { code?: number; name?: string; message?: string };
  return (
    candidate?.code === 4001 ||
    candidate?.name === "UserRejectedRequestError" ||
    candidate?.message?.toLowerCase().includes("user rejected")
  );
}

export function BridgePanel() {
  const { address, isConnected } = useAccount();
  const { connector } = useConnection();
  const { setOpen } = useModal();
  const [chains, setChains] = useState<ExtendedChain[]>([]);
  const [fromChainId, setFromChainId] = useState<number>();
  const [toChainId, setToChainId] = useState<number>();
  const [fromToken, setFromToken] = useState<Token>();
  const [toToken, setToToken] = useState<Token>();
  const [amount, setAmount] = useState("");
  const setMaxAmount = async () => {
    if (!address || !fromChainId || !fromToken || isExecuting) return;

    try {
      const balance = await getBridgeTokenBalance({
        address: address as Address,
        chainId: fromChainId,
        chains,
        token: fromToken,
      });

      let maxBalance = balance;

      // Keep a small amount of native currency available for gas.
      if (fromToken.address.toLowerCase() === zeroAddress) {
        const gasReserve = parseUnits("0.0005", fromToken.decimals);
        maxBalance = maxBalance > gasReserve ? maxBalance - gasReserve : 0n;
      }

      setAmount(formatUnits(maxBalance, fromToken.decimals));
      setRoute(undefined);
      setExecutionRoute(undefined);
      setRecoveredRoute(undefined);
      setError("");
      setExecutionMessage("");
    } catch {
      setError(`Unable to read your ${fromToken.symbol} balance.`);
    }
  };
  const [recipient, setRecipient] = useState("");
  const [route, setRoute] = useState<Route>();
  const [executionRoute, setExecutionRoute] = useState<RouteExtended>();
  const [recoveredRoute, setRecoveredRoute] = useState<RouteExtended>();
  const [recoveredRouteExpired, setRecoveredRouteExpired] = useState(false);
  const [isLoadingChains, setIsLoadingChains] = useState(true);
  const [isLoadingConnections, setIsLoadingConnections] = useState(false);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState("");
  const [executionMessage, setExecutionMessage] = useState("");

  const availableDestinationChains = useMemo(
    () => chains.filter((chain) => chain.id !== fromChainId),
    [chains, fromChainId],
  );
  const activeExecutionRoute = executionRoute ?? recoveredRoute;
  const processes = activeExecutionRoute?.steps.flatMap((step) => step.execution?.process ?? []) ?? [];
  const routeTools = route
    ? [...new Set(route.steps.map((step) => step.toolDetails.name || step.tool))]
    : [];
  const routeDuration = route?.steps.reduce(
    (total, step) => total + (step.estimate?.executionDuration ?? 0),
    0,
  );

  const loadChains = async () => {
    setIsLoadingChains(true);
    setError("");

    try {
      const nextChains = await getSupportedEvmChains();
      setChains(nextChains);
      setFromChainId((current) => current ?? nextChains[0]?.id);
      setToChainId((current) => current ?? nextChains[1]?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load LI.FI networks.");
    } finally {
      setIsLoadingChains(false);
    }
  };

  useEffect(() => {
    void loadChains();
  }, []);

  useEffect(() => {
    if (!fromChainId || !toChainId) return;

    let isCurrent = true;
    setIsLoadingConnections(true);
    setError("");
    void getSupportedConnections(fromChainId, toChainId)
      .then((connections) => {
        if (isCurrent) {
          setError(connections.length === 0 ? "LI.FI currently has no available connection between these networks." : "");
        }
      })
      .catch((err) => {
        if (isCurrent) {
          setError(err instanceof Error ? err.message : "Unable to validate this network pair.");
        }
      })
      .finally(() => {
        if (isCurrent) setIsLoadingConnections(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [fromChainId, toChainId]);

  useEffect(() => {
    if (!address || !connector || chains.length === 0) return;

    configureBridgeEvmProvider({
      address: address as Address,
      connector: connector as never,
      chains,
    });
  }, [address, chains, connector]);

  useEffect(() => {
    setRecoveredRoute(undefined);
    setRecoveredRouteExpired(false);
    if (!address) return;

    try {
      const rawRoute = window.localStorage.getItem(routeRecoveryKey(address));
      if (!rawRoute) return;

      const storedRoute: unknown = JSON.parse(rawRoute);
      if (!isStoredBridgeRoute(storedRoute) || storedRoute.walletAddress !== address.toLowerCase()) {
        window.localStorage.removeItem(routeRecoveryKey(address));
        return;
      }

      const parsedRoute: unknown = JSON.parse(storedRoute.route);
      if (
        !isRestorableRoute(parsedRoute) ||
        parsedRoute.id !== storedRoute.routeId ||
        parsedRoute.fromChainId !== storedRoute.fromChainId ||
        parsedRoute.toChainId !== storedRoute.toChainId
      ) {
        window.localStorage.removeItem(routeRecoveryKey(address));
        return;
      }

      setRecoveredRoute(parsedRoute);
      setRecoveredRouteExpired(Date.now() - storedRoute.timestamp > ROUTE_RECOVERY_MAX_AGE_MS);
    } catch {
      window.localStorage.removeItem(routeRecoveryKey(address));
    }
  }, [address]);

  const requestRoute = async () => {
    if (!isConnected || !address) {
      setOpen(true);
      return;
    }
    if (!fromChainId || !toChainId || !fromToken || !toToken || !amount) {
      setError("Choose networks, tokens, and an amount before requesting a route.");
      return;
    }

    if (fromChainId === toChainId) {
      setError("Choose different source and destination networks.");
      return;
    }

    const normalizedAmount = amount.trim();
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalizedAmount)) {
      setError("Enter a valid decimal amount.");
      return;
    }

    const destinationAddress = recipient.trim() || address;
    if (!isAddress(destinationAddress)) {
      setError("Enter a valid EVM recipient address.");
      return;
    }

    setIsQuoting(true);
    setError("");
    setRoute(undefined);
    setExecutionRoute(undefined);
    setExecutionMessage("Preparing route");

    try {
      const parsedAmount = parseUnits(normalizedAmount, fromToken.decimals);
      if (parsedAmount <= 0n) {
        throw new Error("Enter an amount greater than zero.");
      }

      const balance = await getBridgeTokenBalance({
        address: address as Address,
        chainId: fromChainId,
        chains,
        token: fromToken,
      });
      if (parsedAmount > balance) {
        throw new Error(`Amount exceeds your ${fromToken.symbol} balance on the source network.`);
      }

      const fromAmount = parsedAmount.toString();
      const result = await getRoutes({
        fromChainId,
        fromTokenAddress: fromToken.address,
        fromAmount,
        fromAddress: address,
        toChainId,
        toTokenAddress: toToken.address,
        toAddress: destinationAddress,
        options: {
          integrator: BRIDGE_INTEGRATOR,
          fee: BRIDGE_FEE,
          allowSwitchChain: true,
          allowDestinationCall: false,
        },
      });
      const bestRoute = result.routes[0];
      if (!bestRoute) {
        throw new Error("LI.FI found no route for this transfer.");
      }
      setRoute(bestRoute);
      setExecutionMessage("Route ready");
    } catch (err) {
      setExecutionMessage("");
      setError(err instanceof Error ? err.message : "Unable to request a LI.FI route.");
    } finally {
      setIsQuoting(false);
    }
  };

  const updateRoute = (updatedRoute: RouteExtended) => {
    setExecutionRoute(updatedRoute);
    setRecoveredRoute(undefined);
    if (address) saveRouteRecovery(address as Address, updatedRoute);
    const latestProcess = updatedRoute.steps
      .flatMap((step) => step.execution?.process ?? [])
      .at(-1);
    if (latestProcess) {
      setExecutionMessage(processLabel(latestProcess));
    }
  };

  const executeBridge = async (resume = false) => {
    const routeToExecute = executionRoute ?? recoveredRoute ?? route;
    if (!routeToExecute || !address || !connector) return;

    setIsExecuting(true);
    setError("");
    setExecutionMessage(resume ? "Resuming route" : "Preparing route");

    try {
      const executionOptions = {
        updateRouteHook: updateRoute,
        acceptExchangeRateUpdateHook: async () =>
          window.confirm("The route rate changed. Continue with the updated amount?"),
      };
      const result = resume
        ? await resumeRoute(routeToExecute, executionOptions)
        : await executeRoute(routeToExecute, executionOptions);
      updateRoute(result);
      const isComplete = isRouteComplete(result);
      if (isComplete) {
        window.localStorage.removeItem(routeRecoveryKey(address as Address));
        setRecoveredRoute(undefined);
        recordAchievementEvent(address, {
          type: "bridge-complete",
          fromChainId: routeToExecute.fromChainId,
          toChainId: routeToExecute.toChainId,
          volumeUsd: Number(routeToExecute.fromAmountUSD ?? 0),
        });
      }
      setExecutionMessage(isComplete ? "Completed" : "Route paused — resume when ready");
    } catch (err) {
      setExecutionMessage(isUserRejection(err) ? "User rejected" : "Failed");
      setError(err instanceof Error ? err.message : "LI.FI route execution failed.");
    } finally {
      setIsExecuting(false);
    }
  };

  const dismissRecoveredRoute = () => {
    if (!address) return;
    window.localStorage.removeItem(routeRecoveryKey(address as Address));
    setRecoveredRoute(undefined);
    setRecoveredRouteExpired(false);
  };

  return (
    <section className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl sm:p-8">
      <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-emerald-500/5 blur-2xl" />
      <div className="relative space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
              <ArrowRightLeft size={21} strokeWidth={1.75} />
            </div>
            <h2 className="text-2xl font-black uppercase italic tracking-tight text-zinc-100 sm:text-3xl">
              Bridge
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-400">
              Move supported EVM assets across LI.FI-supported networks.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadChains()}
            disabled={isLoadingChains}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-950 text-zinc-400 transition-colors hover:border-emerald-500/40 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Refresh LI.FI networks"
          >
            <RefreshCw className={isLoadingChains ? "animate-spin" : ""} size={16} />
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-zinc-500">
              From network
            </span>
            <select
              value={fromChainId ?? ""}
              onChange={(event) => {
                const nextChainId = Number(event.target.value);
                setFromChainId(nextChainId);
                setFromToken(undefined);
                setRoute(undefined);
                if (nextChainId === toChainId) {
                  setToChainId(chains.find((chain) => chain.id !== nextChainId)?.id);
                }
              }}
              disabled={isLoadingChains || chains.length === 0 || isExecuting}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none transition-colors focus:border-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {chains.map((chain) => <option key={chain.id} value={chain.id}>{chain.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-2 block text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-zinc-500">To network</span>
            <select
              value={toChainId ?? ""}
              onChange={(event) => {
                setToChainId(Number(event.target.value));
                setToToken(undefined);
                setRoute(undefined);
              }}
              disabled={isLoadingChains || availableDestinationChains.length === 0 || isExecuting}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none transition-colors focus:border-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {availableDestinationChains.map((chain) => <option key={chain.id} value={chain.id}>{chain.name}</option>)}
            </select>
          </label>
          <TokenPicker address={address as Address | undefined} chainId={fromChainId} chains={chains} disabled={isExecuting} label="From token" selectedToken={fromToken} onSelect={setFromToken} />
          <TokenPicker address={address as Address | undefined} chainId={toChainId} chains={chains} disabled={isExecuting} label="To token" selectedToken={toToken} onSelect={setToToken} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-zinc-500">
              Amount
            </span>

            <div className="relative">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setRoute(undefined);
                }}
                placeholder="0.0"
                disabled={isExecuting}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950 py-2.5 pl-3 pr-16 text-sm text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-50"
              />

              <button
                type="button"
                onClick={() => void setMaxAmount()}
                disabled={!address || !fromToken || isExecuting}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2.5 py-1 text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-emerald-400 transition-colors hover:bg-emerald-500/10 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                MAX
              </button>
            </div>
          </label>
          <label className="block">
            <span className="mb-2 block text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-zinc-500">Recipient <span className="normal-case tracking-normal text-zinc-600">(optional)</span></span>
            <input
              value={recipient}
              onChange={(event) => { setRecipient(event.target.value); setRoute(undefined); }}
              placeholder={address || "Your connected wallet"}
              disabled={isExecuting}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-200 outline-none transition-colors placeholder:text-zinc-600 focus:border-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
        </div>

        {!isConnected ? (
          <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-black uppercase tracking-wide text-zinc-950 transition-colors hover:bg-emerald-400">
            <Wallet size={17} /> Connect wallet to bridge
          </button>
        ) : (
          <button type="button" onClick={() => void requestRoute()} disabled={isQuoting || isExecuting || isLoadingConnections} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-black uppercase tracking-wide text-zinc-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">
            {isQuoting ? <Loader2 className="animate-spin" size={17} /> : <RefreshCw size={17} />}
            {isQuoting ? "Finding best route" : "Get bridge route"}
          </button>
        )}

        {route && (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 sm:p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-emerald-400">Best LI.FI route</span>
              <span className="text-xs font-mono text-zinc-500">{formatDuration(routeDuration)}</span>
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div><span className="block text-xs text-zinc-500">You receive</span><strong className="text-zinc-100">{formatTokenAmount(route.toAmount, route.toToken)} {route.toToken.symbol}</strong></div>
              <div><span className="block text-xs text-zinc-500">Route tools</span><strong className="text-zinc-100">{routeTools.join(" · ")}</strong></div>
            </div>
            <button type="button" onClick={() => void executeBridge()} disabled={isExecuting} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-500/15 px-4 py-3 text-sm font-black uppercase tracking-wide text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50">
              {isExecuting ? <Loader2 className="animate-spin" size={17} /> : <Play size={17} />}
              {isExecuting ? executionMessage || "Executing" : "Execute bridge"}
            </button>
          </div>
        )}

        {recoveredRoute && !executionRoute && (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="block text-[10px] font-mono font-bold uppercase tracking-[0.16em] text-amber-300">Resume Bridge</span>
                <p className="mt-2 text-sm leading-6 text-zinc-300">
                  {recoveredRouteExpired
                    ? "This saved route is over seven days old and may no longer be executable."
                    : "An unfinished bridge route for this wallet was found on this device."}
                </p>
              </div>
              <button type="button" onClick={dismissRecoveredRoute} className="text-zinc-500 transition-colors hover:text-zinc-200" aria-label="Dismiss saved bridge route">
                <X size={17} />
              </button>
            </div>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button type="button" onClick={() => void executeBridge(true)} disabled={isExecuting} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm font-black uppercase tracking-wide text-amber-200 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50">
                {isExecuting ? <Loader2 className="animate-spin" size={17} /> : <Play size={17} />}
                Resume Bridge
              </button>
              <button type="button" onClick={dismissRecoveredRoute} disabled={isExecuting} className="rounded-xl border border-zinc-700 px-4 py-3 text-xs font-bold uppercase tracking-wide text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50">
                Dismiss
              </button>
            </div>
          </div>
        )}

        {(activeExecutionRoute || executionMessage) && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-bold text-zinc-200"><CheckCircle2 size={16} className="text-emerald-400" /> {executionMessage || "Preparing route"}</div>
            <div className="space-y-2">
              {processes.map((process, index) => (
                <div key={`${process.type}-${process.txHash ?? index}`} className="flex items-center justify-between gap-3 text-xs text-zinc-400">
                  <span>{processLabel(process)}</span>
                  {process.txLink && <a href={process.txLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300">Explorer <ExternalLink size={12} /></a>}
                </div>
              ))}
            </div>
            {activeExecutionRoute && !isRouteComplete(activeExecutionRoute) && !isExecuting && (
              <button type="button" onClick={() => void executeBridge(true)} className="mt-4 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-bold uppercase tracking-wide text-zinc-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-400">Resume Bridge</button>
            )}
          </div>
        )}

        {error && <div className="flex gap-3 rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300"><AlertCircle className="mt-0.5 shrink-0" size={17} /><p>{error}</p></div>}
      </div>
    </section>
  );
}
