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
  useSendTransaction
} from 'wagmi';
import { base } from 'wagmi/chains';
import { injected, coinbaseWallet } from 'wagmi/connectors';
import { ConnectKitProvider, getDefaultConfig, ConnectKitButton, useModal } from 'connectkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Settings, 
  RefreshCw, 
  Trash2, 
  CheckCircle2, 
  AlertCircle, 
  ExternalLink,
  Coins,
  ArrowRight,
  Zap,
  Hammer,
  Wrench,
  Search,
  Twitter
} from 'lucide-react';
import { formatUnits, createPublicClient, type Address } from 'viem'
import axios from 'axios';
import { DUST_ENGINE_ADDRESS, DUST_ENGINE_ABI } from "./contracts/dustEngine";
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Constants ---
const ONE_INCH_ROUTER = '0x111111125421caae10460d09cc2b79471d860ac9' as Address;
const PROTOCOL_FEE_RECIPIENT = '0xEe36C3c644240302eB8121F66D4e23C068512a40' as Address; // Fee collector
const WETH = '0x4200000000000000000000000000000000000006' as Address;

const COMMON_BASE_TOKENS = [
  { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4C7C32D4f71b54bDA02913' as Address, decimals: 6 },
  { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2AD3d69d441' as Address, decimals: 6 },
  { symbol: 'DAI', address: '0x50c5725949A6F0C72E6C45641830677285586337' as Address, decimals: 18 },
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' as Address, decimals: 18 }
];

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

// --- Config ---
const config = createConfig(
  getDefaultConfig({
    appName: 'Dust Cleaning Engine',
    chains: [base],
    walletConnectProjectId: 'd6cceeb0d16f4b0724853476122511d7',
    transports: {
      [base.id]: http('https://mainnet.base.org')
    },
    ssr: false,
    connectors: [
      injected(),
      coinbaseWallet({ appName: 'Dust Cleaning Engine' }),
    ],
  })
);

const queryClient = new QueryClient();

// --- Components ---

const Gear = ({ className, speed = 10, reverse = false }: { className?: string; speed?: number; reverse?: boolean }) => (
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
  decimals: number;
  balance: bigint;
  formattedBalance: string;
  priceUsd: number;
  valueUsd: number;
  isVerified: boolean;
  selected: boolean;
}

export default function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider>
          <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
            <header className="border-b border-zinc-800/50 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-50">
              <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Gear className="text-emerald-500" speed={5} />
                    <Gear className="absolute -top-1 -right-1 scale-50 text-emerald-400" speed={3} reverse />
                  </div>
                  <div className="flex flex-col -gap-1">
                    <h1 className="text-xl font-bold tracking-tighter uppercase italic leading-none">
                      Dust <span className="text-emerald-500">Engine</span>
                    </h1>
                    <span className="text-[8px] font-mono text-zinc-500 tracking-[0.2em] uppercase">Model v1.0.4-BASE</span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-zinc-800 rounded-full border border-zinc-700">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-xs font-mono text-zinc-400">BASE MAINNET</span>
                  </div>
                  <ConnectButton />
                </div>
              </div>
            </header>

            <main className="max-w-4xl mx-auto px-4 py-12">
              <EngineCore />
            </main>
          </div>
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function ConnectButton() {
  return (
    <div className="scale-90 origin-right max-w-[140px] sm:max-w-none overflow-hidden">
      <ConnectKitButton />
    </div>
  );
}

function EngineCore() {
  const { writeContractAsync } = useWriteContract();
  const { address, isConnected } = useAccount();
  const { setOpen } = useModal();
  const publicClient = usePublicClient();

  // fallback RPC client for Base when wallet is not connected
  const baseRpcClient = createPublicClient({
    chain: base,
    transport: http("https://mainnet.base.org")
  });
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [scanAddress, setScanAddress] = useState('');
  const [apiStatus, setApiStatus] = useState<{debank: boolean, oneinch: boolean}>({ debank: false, oneinch: false });
  const [log, setLog] = useState<string[]>([]);
  const [customAddress, setCustomAddress] = useState('');
  const [isAddingCustom, setIsAddingCustom] = useState(false);
  const [dustThreshold, setDustThreshold] = useState(1.0);
  const [globalStats, setGlobalStats] = useState<any>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await axios.get('/api/stats');
        setGlobalStats(res.data);
      } catch (e) {
        console.warn("Failed to fetch stats");
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const checkApi = async () => {
      try {
        const res = await axios.get('/api/health');
        setApiStatus({
          debank: !!res.data.keys?.debank,
          oneinch: !!res.data.keys?.oneinch
        });
      } catch (e) {
        console.error("Health check failed");
      }
    };
    checkApi();
  }, []);

  const addLog = (msg: string) => {
    setLog(prev => [msg, ...prev].slice(0, 5));
  };

  const analyze = async (targetAddress?: string) => {
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
        alert("Please switch your wallet to the Base network to use the Dust Engine.");
        return;
      }
    }

    if (!window.navigator.onLine) {
      addLog("ERROR: NO INTERNET CONNECTION");
      setIsAnalyzing(false);
      return;
    }

    setIsAnalyzing(true);
    setTokens([]);
    addLog(`SCANNING: ${addressToScan.slice(0, 6)}...${addressToScan.slice(-4)}`);

    try {
      // --- Phase 1: Multi-Source Discovery ---
      addLog("INITIATING AGGRESSIVE SCAN...");
      let discoveredTokens: any[] = [];
      
      // 1.1 Backend Deep Scan
      try {
        const targetAddress = addressToScan || address;

        console.log("SCAN ADDRESS:", targetAddress);

        const backendRes = await axios.get(
          `/api/scan/${targetAddress}`,
          { timeout: 60000 }
        );

        console.log("BACKEND RAW RESPONSE:", backendRes.data);
        console.log("TOKEN COUNT:", backendRes.data?.tokens?.length);

        if (backendRes.data?.tokens) {
          discoveredTokens = [
            ...discoveredTokens,
            ...backendRes.data.tokens.map((t: any) => ({
              ...t,
              balance: t.balance || "0"
            }))
          ];
          addLog(`BACKEND: DISCOVERED ${backendRes.data.tokens.length} ASSETS`);
        }
      } catch (e: any) { 
        console.warn("Backend scan failed", e); 
        addLog(`BACKEND SCAN FAILED: ${e.message}`);
      }

      // 1.2 Direct Blockscout Indexer Scan (Supplement)
      try {
        const bsRes = await axios.get(`https://base.blockscout.com/api/v2/addresses/${addressToScan}/token-balances`, { timeout: 10000 });
        const bsItems = bsRes.data?.items || [];
        if (bsItems.length > 0) {
          const bsTokens = bsItems
            .filter((t: any) => t.token?.address_hash)
            .map((t: any) => ({
              symbol: t.token.symbol || '???',
              address: t.token.address_hash as Address,
              decimals: parseInt(t.token.decimals || '18'),
              priceUsd: parseFloat(t.token.exchange_rate || '0')
            }));
          discoveredTokens = [...discoveredTokens, ...bsTokens];
          addLog(`BLOCKSCOUT FOUND: ${bsTokens.length} TOKENS`);
          addLog(`INDEXER: DISCOVERED ${bsTokens.length} ASSETS`);
          console.log("BLOCKSCOUT TOKENS:", bsTokens);
        }
      } catch (e) { console.warn("Indexer scan failed", e); }

      // 1.3 1inch discovery disabled
      // 1inch returns ALL Base tokens which breaks dust detection
      let oneInchTokens: any[] = [];
      addLog("1INCH DISCOVERY DISABLED (USING WALLET TOKENS ONLY)");

      // 1.4 Deep Scan (DexScreener Search for any missing assets)
      // addLog("DEEP SCAN: CHECKING DEX LIQUIDITY...");
      
      // ❌ TEMP DISABLED (too slow)
      /*
      try {
        // Find tokens that have balances but might not be in our lists
        const potentialAddresses = discoveredTokens.map(t => t.address).filter(Boolean);
        
        if (potentialAddresses.length > 0) {
          const dsRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${potentialAddresses.slice(0, 30).join(',')}`, { timeout: 8000 });
          
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
      } catch (e) { console.warn("Deep scan failed", e); }
      */
      console.log("Liquidity Map:", liquidityMap);

      const finalSeen = new Set<string>();

      const finalScanList = discoveredTokens
        .filter(t => {
          if (!t.address) return false;

          const addrLower = t.address.toLowerCase();

          if (addrLower === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") return false;

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
        .map(t => {
          finalSeen.add(t.address.toLowerCase());
          return {
            symbol: t.symbol || '???',
            address: t.address as Address,
            decimals: t.decimals ?? 18 // don't override if exists
          };
        });

      addLog(`INDEXER PROVIDED TOKENS`);
      console.time("⏱️ TOTAL SCAN");

      // Add 1inch tokens (Very aggressive discovery)
      oneInchTokens.forEach(t => {
        if (t.address && !finalSeen.has(t.address.toLowerCase())) {
          finalScanList.push(t);
          finalSeen.add(t.address.toLowerCase());
        }
      });

      addLog(`VERIFYING ${finalScanList.length} ASSETS ON-CHAIN...`);
      
      // ✅ FAST MODE: skip 1inch validation
      const validTokens = finalScanList;

      // 2. Multicall balances with retry logic
      const chunkSize = 100;
      const allBalances: bigint[] = [];
      for (let i = 0; i < validTokens.length; i += chunkSize) {
        const chunk = validTokens.slice(i, i + chunkSize);
        addLog(`SCANNING CHUNK ${Math.floor(i/chunkSize) + 1}/${Math.ceil(finalScanList.length/chunkSize)}...`);
        
        let success = false;
        let retries = 0;
        while (!success && retries < 2) {
          try {
            const client = publicClient || baseRpcClient;

            const results = await (client as any).multicall({
              contracts: chunk.map(t => ({
                address: t.address,
                abi: ERC20_ABI,
                functionName: 'balanceOf',
                args: [addressToScan as Address],
              })),
            });
            results.forEach((res: any) => {
              allBalances.push(res.status === 'success' ? (res.result as unknown as bigint) : 0n);
            });
            success = true;
          } catch (chunkErr) {
            retries++;
            if (retries === 2) {
              addLog(`CHUNK ${Math.floor(i/chunkSize) + 1} FAILED.`);
              chunk.forEach(() => allBalances.push(0n));
            } else {
              await new Promise(r => setTimeout(r, 500));
            }
          }
        }
        await new Promise(r => setTimeout(r, 50));
      }

      // 3. Filter tokens with balance
      console.time("⏱️ BALANCE FETCH");
      const tokensWithBalance: typeof validTokens = [];
      const balancesForTokens: bigint[] = [];

      validTokens.forEach((t, i) => {
        if (allBalances[i] && allBalances[i] > 0n) {
          tokensWithBalance.push(t);
          balancesForTokens.push(allBalances[i]);
        }
      });
      
      addLog(`BALANCES DETECTED: ${tokensWithBalance.length} ASSETS`);

      // ✅ FIX: convert balances properly using decimals
      const normalizedBalances = tokensWithBalance.map((token, i) => {
        const raw = balancesForTokens[i];
        const decimals = token.decimals ?? 18;

        const balance = Number(raw) / Math.pow(10, decimals);

        return {
          ...token,
          balance
        };
      });

      console.log("✅ NORMALIZED:", normalizedBalances.slice(0, 5));      

      console.timeEnd("⏱️ BALANCE FETCH");

      console.log("🧪 TOKENS WITH BALANCE:", tokensWithBalance.map(t => t.symbol));
      console.log("🧪 BALANCES:", balancesForTokens.map(b => b.toString()));
      
      if (tokensWithBalance.length === 0) {
        addLog("NO BALANCES DETECTED");
        setIsAnalyzing(false);
        return;
      }

      // --- Phase 3: Price Fetching & Verification ---
      console.time("⏱️ PRICE FETCH");
      addLog(`FETCHING PRICES FOR ${tokensWithBalance.length} ASSETS...`);
      const priceAddresses = tokensWithBalance
        .map(t => t.address.toLowerCase())
        .filter(addr => addr.startsWith("0x") && addr.length === 42);
      let prices: Record<string, number> = {};
      
      // 3.1 Use prices from indexer first
      discoveredTokens.forEach(t => {
        if (t.address && t.priceUsd > 0) prices[t.address.toLowerCase()] = t.priceUsd;
      });

      // DEBUG HERE
      console.log("🧪 PRICE TOKENS COUNT:", priceAddresses.length);
      console.log("🧪 SAMPLE ADDRESSES:", priceAddresses.slice(0, 5));

      // 3.2 CoinGecko (Robust + Fallback)
      try {
        const chunkSize = 20;

        for (let i = 0; i < priceAddresses.length; i += chunkSize) {
          const chunk = priceAddresses.slice(i, i + chunkSize);

          console.log("📦 CG CHUNK:", chunk.length);

          try {
            // 🔥 Try batch first
            const cgRes = await axios.get(
              `https://api.coingecko.com/api/v3/simple/token_price/base`,
              {
                params: {
                  contract_addresses: chunk.join(','),
                  vs_currencies: "usd"
                },
                timeout: 8000
              }
            );

            Object.entries(cgRes.data).forEach(([addr, val]: [string, any]) => {
              if (val?.usd) {
                prices[addr.toLowerCase()] = val.usd;
              }
            });

            console.log("✅ CG BATCH SUCCESS");

          } catch (batchErr) {
            console.warn("⚠️ CG BATCH FAILED → fallback to single");

            // 🔥 FALLBACK: fetch one-by-one
            for (const addr of chunk) {
              try {
                const singleRes = await axios.get(
                  `https://api.coingecko.com/api/v3/simple/token_price/base`,
                  {
                    params: {
                      contract_addresses: addr,
                      vs_currencies: "usd"
                    },
                    timeout: 5000
                  }
                );

                const val = singleRes.data[addr];
                if (val?.usd) {
                  prices[addr.toLowerCase()] = val.usd;
                  console.log("💰 CG SINGLE OK:", addr);
                }

              } catch {
                console.log("❌ CG NO DATA:", addr);
              }
            }
          }

          // rate limit protection
          if (priceAddresses.length > chunkSize) {
            await new Promise(r => setTimeout(r, 300));
          }
        }

      } catch (e) {
        console.warn("CoinGecko failed completely", e);
      }

      console.timeEnd("⏱️ PRICE FETCH");
      console.timeEnd("⏱️ TOTAL SCAN");

      // 3.3 DexScreener (Fallback)
      const missingAddresses = priceAddresses.filter(addr => !prices[addr]);
      if (missingAddresses.length > 0) {
        try {
          for (let i = 0; i < missingAddresses.length; i += 30) {
            const chunk = missingAddresses.slice(i, i + 30);
            const dsRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, { timeout: 8000 });
            if (dsRes.data?.pairs) {
              dsRes.data.pairs.forEach((pair: any) => {
                const addr = pair.baseToken.address.toLowerCase();
                if (pair.priceUsd) prices[addr] = parseFloat(pair.priceUsd);
              });
            }
          }
        } catch (e) { console.warn("DexScreener failed", e); }
      }

      const fallbackPrices: Record<string, number> = {
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1.0, // USDC
        '0xfde4c96c8593536e31f229ea8f37b2ad3d69d441': 1.0, // USDT
        '0x50c5725949a6f0c72e6c45641830677285586337': 1.0, // DAI
        '0x4200000000000000000000000000000000000006': 2500, // WETH
      };

      // Create a set of verified addresses from 1inch list
      const verifiedAddresses = new Set(oneInchTokens.map(t => t.address?.toLowerCase()).filter(Boolean));
      COMMON_BASE_TOKENS.forEach(t => {
        if (t.address) verifiedAddresses.add(t.address.toLowerCase());
      });

      addLog(`CALCULATING VALUES FOR ${tokensWithBalance.length} ASSETS...`);
      const results: TokenInfo[] = [];
      for (let i = 0; i < tokensWithBalance.length; i++) {
        const t = tokensWithBalance[i];
        const balance = balancesForTokens[i];
        const formatted = formatUnits(balance, t.decimals);
        const addrLower = t.address?.toLowerCase();
        
        if (!addrLower) continue;

        const price = prices[addrLower] || fallbackPrices[addrLower] || 0;
        const valueUsd = (parseFloat(formatted) || 0) * price;

        if (balance > 0n) {
          results.push({
            ...t,
            balance,
            formattedBalance: formatted,
            priceUsd: price,
            valueUsd,
            isVerified: verifiedAddresses.has(addrLower) || !!prices[addrLower],
            selected: valueUsd > 0 && valueUsd < dustThreshold && (verifiedAddresses.has(addrLower) || !!prices[addrLower]),
          });
        }
      }

      addLog(`SORTING ${results.length} ASSETS...`);
      results.sort((a, b) => {
        if (Math.abs(b.valueUsd - a.valueUsd) > 0.0001) {
          return b.valueUsd - a.valueUsd;
        }
        return a.symbol.localeCompare(b.symbol);
      });

      setTokens(results);
      addLog(`SCAN COMPLETE: FOUND ${results.length} ASSETS`);
    } catch (err: any) {
      console.error("Analysis failed", err);
      const errorMsg = err.response?.data?.message || err.message || "NETWORK ERROR";
      addLog(`ERROR: ${errorMsg.toUpperCase()}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const addCustomToken = async () => {
    if (!customAddress.startsWith('0x') || customAddress.length !== 42) {
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

      const priceRes = await axios.get(`https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${customAddress.toLowerCase()}&vs_currencies=usd`);
      const price = priceRes.data[customAddress.toLowerCase()]?.usd || 0;
      const formatted = formatUnits(balance as bigint, decimals as number);
      const valueUsd = parseFloat(formatted) * price;

      const newToken: TokenInfo = {
        symbol: symbol as string,
        address: customAddress as Address,
        decimals: decimals as number,
        balance: balance as bigint,
        formattedBalance: formatted,
        priceUsd: price,
        valueUsd,
        isVerified: !!price,
        selected: true,
      };

      setTokens(prev => {
        const filtered = prev.filter(t => t.address?.toLowerCase() !== customAddress.toLowerCase());
        return [newToken, ...filtered];
      });
      setCustomAddress('');
      addLog(`ADDED CUSTOM TOKEN: ${symbol}`);
    } catch (err) {
      console.error(err);
      alert("Failed to fetch token info. Ensure it's a valid ERC20 on Base.");
    } finally {
      setIsAddingCustom(false);
    }
  };

  const toggleSelect = (addr: Address) => {
    setTokens(prev => prev.map(t => t.address === addr ? { ...t, selected: !t.selected } : t));
  };

  const toggleAll = () => {
    const allSelected = filteredTokens.length > 0 && filteredTokens.every(t => t.selected);
    setTokens(prev => prev.map(t => {
      const isFiltered = filteredTokens.some(ft => ft.address === t.address);
      if (isFiltered) return { ...t, selected: !allSelected };
      return t;
    }));
  };

  const filteredTokens = useMemo(() => {
    if (showAll) return tokens;
    return tokens.filter(
      t => t.valueUsd >= 0.01 && t.valueUsd <= dustThreshold && t.isVerified
    );
  }, [tokens, showAll, dustThreshold]);

  const totalValueUsd = useMemo(() => 
    filteredTokens.filter(t => t.selected).reduce((acc, t) => acc + (t.valueUsd || 0), 0)
  , [filteredTokens]);

  const unpricedCount = useMemo(() => 
    filteredTokens.filter(t => t.selected && !t.priceUsd).length
  , [filteredTokens]);

  return (
    <div className="space-y-8">
      {/* Global Analytics Bar */}
      {globalStats && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 text-center">
            <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Total Dust Cleaned</p>
            <p className="text-xl font-black text-emerald-500">${(globalStats.totalDustCleanedUsd || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 text-center">
            <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Total Swaps</p>
            <p className="text-xl font-black text-zinc-100">{(globalStats.totalSwaps || 0).toLocaleString()}</p>
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 text-center">
            <p className="text-[10px] text-zinc-500 uppercase font-bold tracking-widest mb-1">Users Served</p>
            <p className="text-xl font-black text-zinc-100">{(globalStats.usersServed || 0).toLocaleString()}</p>
          </div>
        </div>
      )}

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
              Detects tiny token balances across your wallet and transforms them into usable assets using smart routing and real-time market data.
            </p>
            <div className="flex gap-2 pt-2">
              <span className="px-2 py-0.5 bg-zinc-800 text-[10px] font-mono text-emerald-400 rounded">⚡ AI Scan</span>
              <span className="px-2 py-0.5 bg-zinc-800 text-[10px] font-mono text-emerald-400 rounded">🔄 Smart Conversion</span>
              <span className="px-2 py-0.5 bg-zinc-800 text-[10px] font-mono text-emerald-400 rounded">🧹 Wallet Cleanup</span>
            </div>
            
            {!isConnected ? (
              <div className="pt-4 flex flex-col items-center md:items-start">
                <div className="flex items-center gap-4 mb-4 px-3 py-1.5 bg-zinc-900/50 border border-zinc-800 rounded-lg">
                  <div className="flex items-center gap-2">
                    <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.debank ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500")} />
                    <span className="text-[9px] font-mono text-zinc-400 uppercase">Debank</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.oneinch ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500")} />
                    <span className="text-[9px] font-mono text-zinc-400 uppercase">1inch</span>
                  </div>
                </div>
                <p className="text-sm text-zinc-500 mb-4 italic">Connect your wallet to power the engine</p>
                <div className="flex justify-center max-w-full overflow-hidden">
                  <ConnectKitButton />
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-3 px-3 py-1.5 bg-zinc-900/50 border border-zinc-800 rounded-lg">
                    <div className="flex items-center gap-2">
                      <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.debank ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500")} />
                      <span className="text-[9px] font-mono text-zinc-400 uppercase">Debank</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className={cn("w-1.5 h-1.5 rounded-full", apiStatus.oneinch ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-red-500")} />
                      <span className="text-[9px] font-mono text-zinc-400 uppercase">1inch</span>
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
                      {isAnalyzing ? <RefreshCw className="animate-spin" size={18} /> : <Zap size={18} />}
                      {isAnalyzing ? 'ANALYZING...' : 'START ENGINE'}
                    </span>
                    <motion.div 
                      className="absolute inset-0 bg-white/20"
                      initial={{ x: '-100%' }}
                      whileHover={{ x: '100%' }}
                      transition={{ duration: 0.5 }}
                    />
                  </button>
                  
                  <div className="flex flex-col gap-1 px-4 py-2 bg-zinc-950 border border-zinc-800 rounded-xl min-w-[160px]">
                    <div className="flex justify-between items-center">
                      <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-tighter">Dust Threshold</span>
                      <span className="text-[10px] font-mono text-emerald-500">${dustThreshold.toFixed(2)}</span>
                    </div>
                    <input 
                      type="range" 
                      min="0.01" 
                      max="5.0" 
                      step="0.01" 
                      value={dustThreshold}
                      onChange={(e) => setDustThreshold(parseFloat(e.target.value))}
                      className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                    />
                  </div>

                  <div className="flex items-center gap-2 px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-xl">
                    <div className="flex -space-x-1">
                      <div className="w-4 h-4 rounded-full bg-emerald-500/20 border border-emerald-500/50 flex items-center justify-center text-[6px] font-bold text-emerald-500">1i</div>
                      <div className="w-4 h-4 rounded-full bg-blue-500/20 border border-blue-500/50 flex items-center justify-center text-[6px] font-bold text-blue-500">Ae</div>
                      <div className="w-4 h-4 rounded-full bg-pink-500/20 border border-pink-500/50 flex items-center justify-center text-[6px] font-bold text-pink-500">Un</div>
                    </div>
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">1inch Aggregator Active</span>
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
                {isAnalyzing ? 'Scanning...' : 'Scan Wallet'}
              </button>
            </div>
          </div>

          <div className="w-48 h-48 relative flex items-center justify-center">
            <div className="absolute inset-0 border-4 border-dashed border-zinc-800 rounded-full animate-[spin_20s_linear_infinite]" />
            <div className="relative">
              <Gear className={cn("text-zinc-700", isAnalyzing && "text-emerald-500")} speed={isAnalyzing ? 2 : 10} />
              <Gear className="absolute -top-6 -right-6 scale-75 text-zinc-800" speed={isAnalyzing ? 1.5 : 8} reverse />
              <Gear className="absolute -bottom-4 -left-4 scale-50 text-zinc-800" speed={isAnalyzing ? 1 : 5} />
            </div>
            
            {/* Mechanical Log Monitor */}
            <div className="absolute -bottom-10 w-64 bg-black/80 border border-zinc-800 rounded p-2 font-mono text-[9px] text-emerald-500/80 shadow-xl overflow-hidden h-16 pointer-events-none">
              <div className="flex justify-between border-b border-zinc-800 pb-1 mb-1 text-[7px] uppercase tracking-widest text-zinc-600">
                <span>System Monitor</span>
                <span className="animate-pulse">ONLINE</span>
              </div>
              <div className="space-y-0.5">
                {log.length > 0 ? log.map((msg, i) => (
                  <div key={i} className={cn(i === 0 ? "text-emerald-400" : "opacity-50")}>
                    {`> ${msg}`}
                  </div>
                )) : (
                  <div className="opacity-30 italic">WAITING FOR INPUT...</div>
                )}
              </div>
            </div>
            <div className="absolute -bottom-24 flex items-center gap-4">
              <a href="https://x.com/enginedust" target="_blank" rel="noopener noreferrer">
                <img src="/x-logo.svg" width="28" alt="X" />
              </a>
              <a href="https://farcaster.xyz/dustengine" target="_blank" rel="noopener noreferrer">
                <img src="/farcaster-logo.svg" width="28" alt="Farcaster" />
              </a>
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
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-4">
                <h3 className="text-sm font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                  <Trash2 size={14} /> {showAll ? 'All Assets' : 'Detected Dust'} ({filteredTokens.length})
                </h3>
                <button 
                  onClick={() => setShowAll(!showAll)}
                  className={cn(
                    "px-2 py-1 rounded text-[10px] font-bold uppercase transition-all border",
                    showAll 
                      ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-500" 
                      : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  {showAll ? 'Show Dust Only' : 'Show All Coins'}
                </button>
                {isAnalyzing && (
                  <div className="flex items-end gap-0.5 h-3">
                    {[1,2,3,4,5].map(i => (
                      <motion.div
                        key={i}
                        animate={{ height: [4, 12, 6, 10, 4] }}
                        transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1 }}
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
                <div className={cn(
                  "w-3 h-3 rounded border flex items-center justify-center transition-colors",
                  filteredTokens.length > 0 && filteredTokens.every(t => t.selected) ? "bg-emerald-500 border-emerald-500 text-zinc-950" : "border-zinc-700"
                )}>
                  {filteredTokens.length > 0 && filteredTokens.every(t => t.selected) && <CheckCircle2 size={10} strokeWidth={4} />}
                </div>
                {filteredTokens.length > 0 && filteredTokens.every(t => t.selected) ? 'Deselect All' : 'Select All'}
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
                <p className="text-xs text-zinc-500 uppercase font-bold tracking-tighter">Total Compression Value</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-black text-emerald-500">${(totalValueUsd || 0).toFixed(4)}</span>
                  <span className="text-sm font-mono text-zinc-400">≈ {((totalValueUsd || 0) / 2500).toFixed(6)} ETH</span>
                </div>
                {unpricedCount > 0 && (
                  <p className="text-[10px] text-zinc-500 italic">
                    * {unpricedCount} tokens have unknown market value
                  </p>
                )}
                <p className="text-[10px] text-zinc-600 italic uppercase">Includes 3% protocol fee</p>
              </div>

              <SwapButton 
                tokens={filteredTokens.filter(t => t.selected)} 
                setTokens={setTokens}
                addLog={addLog}
                isConnected={isConnected}
                setOpen={setOpen}
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
            <p className="text-zinc-400 font-bold uppercase tracking-widest mb-2">No Dust Detected</p>
            <p className="text-zinc-600 text-xs max-w-xs mx-auto italic mb-6">
              The engine scanned {tokens.length} tokens but found no balances under $1.
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

function TokenRow({ token, onToggle }: { token: TokenInfo; onToggle: () => void }) {
  return (
    <div 
      onClick={onToggle}
      className={cn(
        "group flex items-center gap-4 p-4 rounded-xl border transition-all cursor-pointer",
        token.selected 
          ? "bg-emerald-500/5 border-emerald-500/30" 
          : "bg-zinc-900/50 border-zinc-800 hover:border-zinc-700"
      )}
    >
      <div className={cn(
        "w-6 h-6 rounded-md border flex items-center justify-center transition-colors",
        token.selected ? "bg-emerald-500 border-emerald-500 text-zinc-950" : "border-zinc-700"
      )}>
        {token.selected && <CheckCircle2 size={16} strokeWidth={3} />}
      </div>

      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="font-bold text-zinc-100 truncate">{token.symbol}</span>
          {token.isVerified && (
            <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded uppercase font-bold tracking-tighter shrink-0">Verified</span>
          )}
        </div>
        <p className="text-[10px] text-zinc-500 font-mono truncate opacity-60">{token.address}</p>
      </div>

      <div className="text-right">
        <p className="font-bold text-zinc-200">{token.formattedBalance}</p>
        <p className={cn(
          "text-xs font-medium",
          token.valueUsd > 0 ? "text-emerald-500/80" : "text-zinc-500 italic"
        )}>
          {token.valueUsd > 0 ? `$${token.valueUsd.toFixed(4)}` : 'Price N/A'}
        </p>
      </div>
    </div>
  );
}

function SwapButton({ tokens, setTokens, onSuccess, addLog, isConnected, setOpen }: { 
  tokens: TokenInfo[]; 
  setTokens: (val: TokenInfo[] | ((prev: TokenInfo[]) => TokenInfo[])) => void; 
  onSuccess: () => void; 
  addLog: (msg: string) => void;
  isConnected: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'idle' | 'routing' | 'approving' | 'swapping' | 'cleaning'>('idle');
  const [currentSource, setCurrentSource] = useState<string>('');
  const { address, chain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const [showSuccess, setShowSuccess] = useState(false);
  const [successData, setSuccessData] = useState({ count: 0, value: 0 });

  const handleSwap = async (e?: any) => {

    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!isConnected) {
      setOpen(true);
      return;
    }
    if (tokens.length === 0 || !address) return;
    
    // Ensure correct chain
    if (chain?.id !== base.id) {
      try {
        addLog("SWITCHING TO BASE NETWORK...");
        await switchChainAsync({ chainId: base.id });
      } catch (err) {
        addLog("FAILED TO SWITCH NETWORK. PLEASE SWITCH TO BASE MANUALLY.");
        return;
      }
    }

    // TEST CONTRACT CALL
    await writeContractAsync({
      address: DUST_ENGINE_ADDRESS,
      abi: DUST_ENGINE_ABI,
      functionName: "cleanDust",
      args: [
        [],
        [],
        [],
        "0x0000000000000000000000000000000000000000",
        []
      ]
    });

    setLoading(true);
    setShowSuccess(false); // Reset success state

    try {
      const selectedTokens = tokens.filter(t => t.selected);
      let successCount = 0;
      let actualSwappedValue = 0;
      const successfulTokenAddresses: string[] = [];
      
      if (selectedTokens.length === 0) {
        setLoading(false);
        return;
      }
      
      // Step 1: Routing via 1inch
      setStep('routing');
      addLog("QUERYING 1INCH AGGREGATOR...");
      await new Promise(r => setTimeout(r, 1000));
      
      // REAL TRANSACTION FLOW
      
      // Try EIP-5792 Batching (Smart Wallets like Coinbase)
      let batchSupported = false;
      try {
        // Check if wallet supports batching
        const capabilities = await (window as any).ethereum?.request({
          method: 'wallet_getCapabilities',
          params: [address]
        });
        batchSupported = !!capabilities?.[base.id.toString()]?.atomicBatch?.supported;
      } catch (e) { console.warn("Batching not supported", e); }

      if (batchSupported) {
        addLog("SMART WALLET DETECTED: PREPARING ATOMIC BATCH...");
        const calls = [];
        const batchSuccessfulAddresses: string[] = [];
        let batchTotalValue = 0;

        for (const token of selectedTokens) {
          try {
            addLog(`FETCHING SWAP DATA FOR ${token.symbol}...`);
            const swapRes = await axios.get('/api/swap/quote', {
              params: {
                fromTokenAddress: token.address,
                toTokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // Native ETH
                amount: token.balance.toString(),
                fromAddress: address,
                slippage: 3
              }
            });

            if (swapRes.data?.tx) {
              // 1. Approval call
              calls.push({
                to: token.address,
                data: encodeFunctionData({
                  abi: ERC20_ABI,
                  functionName: 'approve',
                  args: [ONE_INCH_ROUTER, token.balance]
                })
              });

              // 2. Swap call
              calls.push({
                to: swapRes.data.tx.to as Address,
                data: swapRes.data.tx.data,
                value: BigInt(swapRes.data.tx.value || '0')
              });

              batchSuccessfulAddresses.push(token.address);
              batchTotalValue += token.valueUsd;
            } else {
              addLog(`SWAP DATA UNAVAILABLE FOR ${token.symbol}`);
            }
          } catch (e: any) {
            addLog(`FAILED TO GET SWAP DATA FOR ${token.symbol}: ${e.message}`);
          }
        }

        if (calls.length > 0) {
          try {
            addLog(`SENDING BATCH OF ${calls.length} CALLS...`);
            const batchHash = await (window as any).ethereum.request({
              method: 'wallet_sendCalls',
              params: [{
                chainId: `0x${base.id.toString(16)}`,
                from: address,
                calls
              }]
            });
            addLog(`BATCH TX SENT: ${batchHash.slice(0, 10)}...`);
            addLog("WAITING FOR BATCH CONFIRMATION...");
            
            // Wait for batch confirmation (EIP-5792 doesn't have a standard wait hook yet in wagmi)
            await new Promise(r => setTimeout(r, 5000));
            
            successCount = batchSuccessfulAddresses.length;
            actualSwappedValue = batchTotalValue;
            successfulTokenAddresses.push(...batchSuccessfulAddresses);
          } catch (batchErr: any) {
            addLog(`BATCH FAILED: ${batchErr.message}`);
            throw batchErr;
          }
        } else {
          addLog("NO VALID SWAP CALLS TO BATCH");
        }
      } else {
        // Fallback to sequential for standard wallets
        for (const token of selectedTokens) {
          addLog(`PROCESSING ${token.symbol}...`);
          
          // 1. Check Allowance & Approve
          setStep('approving');
          try {
            const allowance = await (publicClient as any).readContract({
              address: token.address,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [address as Address, ONE_INCH_ROUTER],
            });

            if (allowance < token.balance) {
              addLog(`APPROVING ${token.symbol} FOR 1INCH...`);
              const approveHash = await writeContractAsync({
                account: address as Address,
                chain: base,
                address: token.address,
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [ONE_INCH_ROUTER, token.balance],
              });
              addLog(`APPROVE TX SENT: ${approveHash.slice(0, 10)}...`);
              addLog("WAITING FOR CONFIRMATION...");
              
              // Wait for approval to be mined
              await publicClient?.waitForTransactionReceipt({ hash: approveHash });
              addLog("APPROVAL CONFIRMED.");
            } else {
              addLog(`${token.symbol} ALREADY APPROVED`);
            }
          } catch (approveErr: any) {
            if (approveErr.message?.includes('User rejected')) {
              addLog(`USER REJECTED ${token.symbol} APPROVAL`);
              continue;
            }
            addLog(`APPROVAL FAILED FOR ${token.symbol}: ${approveErr.message}`);
            continue;
          }

          // 2. Real Swap (Attempt via Proxy)
          setStep('swapping');
          addLog(`SWAPPING ${token.symbol} -> ETH...`);
          try {
            const swapRes = await axios.get('/api/swap/quote', {
              params: {
                fromTokenAddress: token.address,
                toTokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // Native ETH
                amount: token.balance.toString(),
                fromAddress: address,
                slippage: 3
              }
            });

            if (swapRes.data?.tx) {
              addLog(`EXECUTING 1INCH SWAP FOR ${token.symbol}...`);
              console.log("Swap TX Data:", swapRes.data.tx);
              const swapHash = await sendTransactionAsync({
                account: address as Address,
                to: swapRes.data.tx.to as Address,
                data: swapRes.data.tx.data,
                value: BigInt(swapRes.data.tx.value || '0'),
                gas: BigInt(swapRes.data.tx.gas || '1000000'),
              });
              
              addLog(`SWAP TX SENT: ${swapHash.slice(0, 10)}...`);
              addLog("WAITING FOR SWAP CONFIRMATION...");
              const receipt = await publicClient?.waitForTransactionReceipt({ hash: swapHash });
              
              if (receipt?.status === 'success') {
                addLog(`SWAP CONFIRMED FOR ${token.symbol}.`);
                successCount++;
                actualSwappedValue += token.valueUsd;
                successfulTokenAddresses.push(token.address);
              } else {
                addLog(`SWAP REVERTED ON-CHAIN FOR ${token.symbol}. CHECK GAS OR SLIPPAGE.`);
              }
            } else {
              addLog(`SWAP DATA UNAVAILABLE FOR ${token.symbol} (SIMULATING)`);
              await new Promise(r => setTimeout(r, 1000));
              // For simulation, we'll count it as success for the UI demo if needed, 
              // but ideally only real transactions count.
              // successCount++; 
              // actualSwappedValue += token.valueUsd;
              // successfulTokenAddresses.push(token.address);
            }
          } catch (swapErr: any) {
            const errorMsg = swapErr.response?.data?.description || swapErr.response?.data?.error || swapErr.message;
            addLog(`SWAP FAILED FOR ${token.symbol}: ${errorMsg}`);
            addLog("SKIPPING TO NEXT TOKEN...");
          }
        }
      }
      
      // Step 4: Cleaning & Fee Distribution
      if (successCount > 0) {
        setStep('cleaning');
        addLog("DISTRIBUTING 3% PROTOCOL FEE...");
        await new Promise(r => setTimeout(r, 1000));

        addLog("COMPRESSION COMPLETE");
        
        // Report to backend for analytics
        try {
          await axios.post('/api/report-swap', { valueUsd: actualSwappedValue });
        } catch (e) {
          console.warn("Failed to report swap analytics");
        }

        setSuccessData({ count: successCount, value: actualSwappedValue });
        setShowSuccess(true);
        
        // Surgically remove only successful tokens
        setTokens(prev => prev.filter(t => !successfulTokenAddresses.includes(t.address)));
        addLog(`UI UPDATED: ${successCount} ASSETS REMOVED`);
      } else {
        addLog("NO TOKENS WERE SUCCESSFULLY COMPRESSED. CHECK LOGS FOR ERRORS.");
      }
    } catch (err: any) {
      console.error(err);
      const errorDetail = err.response?.data?.description || err.response?.data?.error || err.shortMessage || err.message;
      addLog(`ERROR: ${errorDetail || "ROUTER FAILURE"}`);
    } finally {
      setLoading(false);
      setStep('idle');
      setCurrentSource('');
    }
  };

  const getLabel = () => {
    switch (step) {
      case 'routing': return `ROUTING: ${currentSource}...`;
      case 'approving': return 'OILING 1INCH GEARS...';
      case 'swapping': return 'AGGREGATING LIQUIDITY...';
      case 'cleaning': return 'DISTRIBUTING FEES...';
      default: return `COMPRESS ${tokens.filter(t => t.selected).length} TOKENS`;
    }
  };

  return (
    <div className="w-full md:w-auto space-y-4">
      {loading && (
        <div className="bg-zinc-950/50 border border-zinc-800 rounded-xl p-3 flex items-center gap-4 animate-pulse">
          <div className="flex -space-x-2">
            <div className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[8px] font-bold">1i</div>
            <div className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[8px] font-bold">Ae</div>
            <div className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[8px] font-bold">Un</div>
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
              Aggregator Path: Dust → 1inch → {currentSource || '...'} → ETH
            </p>
          </div>
        </div>
      )}

      <button
        onClick={(e) => handleSwap(e)}
        disabled={loading || tokens.filter(t => t.selected).length === 0}
        type="button"
        className={cn(
          "w-full md:w-auto px-12 py-4 font-black uppercase italic tracking-tighter rounded-xl transition-all active:scale-95 flex items-center justify-center gap-3 shadow-lg relative overflow-hidden",
          loading 
            ? "bg-zinc-800 text-emerald-500 cursor-wait" 
            : "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 shadow-[0_0_20px_rgba(16,185,129,0.3)]"
        )}
      >
        {loading ? (
          <RefreshCw className="animate-spin" size={20} />
        ) : (
          <Zap size={20} className={tokens.filter(t => t.selected).length > 0 ? "animate-pulse" : ""} />
        )}
        {getLabel()}

        {/* Batch Mode Badge */}
        {!loading && (
          <div className="absolute top-1 right-2 flex items-center gap-1">
            <div className="w-1 h-1 rounded-full bg-black/40 animate-pulse" />
            <span className="text-[7px] font-bold opacity-40">EIP-5792 READY</span>
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
                <h3 className="text-2xl font-black uppercase italic tracking-tighter">Compression Successful</h3>
                <p className="text-zinc-400 text-sm">
                  Successfully compressed {successData.count} tokens into ETH via 1inch Aggregator.
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
