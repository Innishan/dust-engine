export type DexScreenerPoolQuote = {
  priceUsd: number;
  source: "dexscreener";
  verified: boolean;
  liquidityUsd?: number;
  volume24hUsd?: number;
  buys24h?: number;
  sells24h?: number;
  chainId?: string;
  baseTokenAddress?: string;
  poolAddress?: string;
  quoteTokenAddress?: string;
  fetchedAt?: number;
};
export type PriceQuote = {
  priceUsd: number;
  source: "local" | "blockscout" | "dexscreener" | "corroborated_market" | "coingecko";
  /** Scanner price acceptance only; this does not mean a LI.FI route exists or is executable. */
  verified: boolean;
  liquidityUsd?: number;
  volume24hUsd?: number;
  buys24h?: number;
  sells24h?: number;
  chainId?: string;
  baseTokenAddress?: string;
  poolAddress?: string;
  quoteTokenAddress?: string;
  fetchedAt?: number;
  /** Bounded, deterministically ordered alternatives from the same DexScreener response. */
  poolCandidates?: DexScreenerPoolQuote[];
};

export type BlockscoutQuote = {
  priceUsd?: number;
  reputation?: string;
  volume24h?: number;
};

export const DEXSCREENER_BATCH_SIZE = 30;
export const MAX_DEXSCREENER_POOLS_PER_TOKEN = 3;
export const DEXSCREENER_BASE_URL = "https://api.dexscreener.com/tokens/v1/base";

export function normalizeTokenAddress(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : undefined;
}

export function validPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function createInitialQuotes(
  localPrices: Record<string, number>,
  blockscoutQuotes: Record<string, BlockscoutQuote> | undefined,
): Record<string, PriceQuote> {
  const quotes: Record<string, PriceQuote> = {};
  for (const [address, priceUsd] of Object.entries(localPrices)) {
    const key = normalizeTokenAddress(address);
    if (key && validPrice(priceUsd)) quotes[key] = { priceUsd, source: "local", verified: true };
  }
  for (const [address, quote] of Object.entries(blockscoutQuotes || {})) {
    const key = normalizeTokenAddress(address);
    if (key && !quotes[key] && validPrice(quote.priceUsd)) {
      quotes[key] = { priceUsd: quote.priceUsd, source: "blockscout", verified: false };
    }
  }
  return quotes;
}

/** Manual additions may use a configured canonical price; provider-only quotes stay indicative. */
export function manualTokenPriceQuote(address: unknown, indicativePrice: number, localPrices: Record<string, number>): PriceQuote | undefined {
  const key = normalizeTokenAddress(address);
  if (!key) return undefined;
  const localPrice = Object.entries(localPrices).find(([candidate]) => normalizeTokenAddress(candidate) === key)?.[1];
  if (validPrice(localPrice)) return { priceUsd: localPrice, source: "local", verified: true };
  if (validPrice(indicativePrice)) return { priceUsd: indicativePrice, source: "coingecko", verified: false };
  return undefined;
}

// Every token passed here has already been independently verified to have a
// positive on-chain balance. These quotes are for display only; eligibility
// never follows from this indicative source alone.
export function indicativePriceAddresses(
  tokens: Array<{ address?: unknown }>,
  wethAddress: string,
): string[] {
  const weth = wethAddress.toLowerCase();
  return [...new Set(tokens.flatMap((token) => {
    const address = normalizeTokenAddress(token.address);
    return address && address !== weth ? [address] : [];
  }))];
}

type DexPair = {
  chainId?: unknown;
  baseToken?: { address?: unknown };
  priceUsd?: unknown;
  liquidity?: { usd?: unknown };
  volume?: { h24?: unknown };
  txns?: { h24?: { buys?: unknown; sells?: unknown } };
  pairAddress?: unknown;
  quoteToken?: { address?: unknown };
};

export function qualifyingDexScreenerQuotes(requestedAddresses: string[], pairs: unknown): Record<string, PriceQuote> {
  const requested = new Set(requestedAddresses.map(normalizeTokenAddress).filter((address): address is string => !!address));
  const candidates = new Map<string, DexScreenerPoolQuote[]>();
  if (!Array.isArray(pairs)) return {};
  for (const pair of pairs as DexPair[]) {
    const address = normalizeTokenAddress(pair?.baseToken?.address);
    const priceUsd = Number(pair?.priceUsd);
    const liquidityUsd = Number(pair?.liquidity?.usd);
    if (pair?.chainId !== "base" || !address || !requested.has(address)
      || !Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(liquidityUsd) || liquidityUsd <= 0) continue;
    const poolAddress = normalizeTokenAddress(pair.pairAddress);
    const quoteTokenAddress = normalizeTokenAddress(pair.quoteToken?.address);
    const volume24hUsd = Number(pair?.volume?.h24);
    const buys24h = Number(pair?.txns?.h24?.buys);
    const sells24h = Number(pair?.txns?.h24?.sells);
    const quote: DexScreenerPoolQuote = {
      priceUsd, source: "dexscreener", verified: false, chainId: "8453", baseTokenAddress: address,
      ...(poolAddress ? { poolAddress } : {}), ...(quoteTokenAddress ? { quoteTokenAddress } : {}),
      fetchedAt: Date.now(), liquidityUsd,
      ...(Number.isFinite(volume24hUsd) && volume24hUsd >= 0 ? { volume24hUsd } : {}),
      ...(Number.isFinite(buys24h) && buys24h >= 0 ? { buys24h } : {}),
      ...(Number.isFinite(sells24h) && sells24h >= 0 ? { sells24h } : {}),
    };
    const tokenCandidates = candidates.get(address) ?? [];
    // A pool address is the identity; duplicate provider rows cannot displace it.
    if (!poolAddress || !tokenCandidates.some((item) => item.poolAddress === poolAddress)) tokenCandidates.push(quote);
    candidates.set(address, tokenCandidates);
  }
  return Object.fromEntries([...candidates].map(([address, tokenCandidates]) => {
    const byLiquidity = tokenCandidates.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)
      || (a.poolAddress ?? "").localeCompare(b.poolAddress ?? ""));
    const primary = byLiquidity[0];
    const alternatives = byLiquidity.slice(1).sort((a, b) => Number(isMarketEvidenceCandidate(b)) - Number(isMarketEvidenceCandidate(a))
      || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) || (a.poolAddress ?? "").localeCompare(b.poolAddress ?? ""));
    const bounded = [primary, ...alternatives].slice(0, MAX_DEXSCREENER_POOLS_PER_TOKEN);
    return [address, { ...primary, poolCandidates: bounded }];
  }));
}

export const MIN_DEX_VOLUME_24H_USD = 1_000;
export const MIN_DEX_TRADES_24H = 10;
export const MIN_TRUSTED_LIQUIDITY_USD = 1_000;

function isMarketEvidenceCandidate(pool: PriceQuote): pool is DexScreenerPoolQuote {
  const tradeCount = (pool.buys24h ?? 0) + (pool.sells24h ?? 0);
  return normalizeTokenAddress(pool.poolAddress) !== undefined && normalizeTokenAddress(pool.quoteTokenAddress) !== undefined
    && pool.source === "dexscreener"
    && Number.isFinite(pool.liquidityUsd) && (pool.liquidityUsd ?? 0) >= MIN_TRUSTED_LIQUIDITY_USD
    && Number.isFinite(pool.volume24hUsd) && (pool.volume24hUsd ?? 0) >= MIN_DEX_VOLUME_24H_USD
    && Number.isFinite(pool.buys24h) && Number.isFinite(pool.sells24h)
    && (pool.buys24h ?? 0) > 0 && (pool.sells24h ?? 0) > 0 && tradeCount >= MIN_DEX_TRADES_24H;
}

export function qualifyingMarketEvidencePools(quote: PriceQuote | undefined): DexScreenerPoolQuote[] {
  const candidates = quote?.poolCandidates?.length ? quote.poolCandidates : quote ? [quote] : [];
  return candidates.filter(isMarketEvidenceCandidate);
}

export function potentialMarketEvidenceAddresses(
  tokens: Array<{ address?: unknown }>,
  dexQuotes: Record<string, PriceQuote>,
  limit = 100,
  excludedAddresses: ReadonlySet<string> = new Set(),
): string[] {
  const excluded = new Set([...excludedAddresses].map((address) => address.toLowerCase()));
  return [...new Set(tokens.flatMap((token) => {
    const address = normalizeTokenAddress(token.address);
    const quote = address ? dexQuotes[address] : undefined;
    const hasQualifyingPool = qualifyingMarketEvidencePools(quote).length > 0;
    return address && !excluded.has(address) && hasQualifyingPool
      ? [address]
      : [];
  }))].slice(0, limit);
}

export function dexScreenerChunks(addresses: string[]): string[][] {
  const normalized = addresses.map(normalizeTokenAddress).filter((address): address is string => !!address);
  const chunks: string[][] = [];
  for (let index = 0; index < normalized.length; index += DEXSCREENER_BATCH_SIZE) chunks.push(normalized.slice(index, index + DEXSCREENER_BATCH_SIZE));
  return chunks;
}

export async function fetchDexScreenerQuotes(
  addresses: string[],
  request: (url: string) => Promise<{ data?: unknown }>,
): Promise<Record<string, PriceQuote>> {
  const quotes: Record<string, PriceQuote> = {};
  for (const chunk of dexScreenerChunks(addresses)) {
    try {
      const response = await request(`${DEXSCREENER_BASE_URL}/${chunk.join(",")}`);
      Object.assign(quotes, qualifyingDexScreenerQuotes(chunk, (response.data as { pairs?: unknown } | undefined)?.pairs ?? response.data));
    } catch {
      // A public endpoint failure leaves the affected tokens unpriced.
    }
  }
  return quotes;
}
