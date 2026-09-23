import { MIN_BLOCKSCOUT_VOLUME_24H_USD } from "./tokenEligibility";

export type PriceQuote = {
  priceUsd: number;
  source: "local" | "blockscout" | "dexscreener";
  verified: boolean;
};

export type BlockscoutQuote = {
  priceUsd?: number;
  reputation?: string;
  volume24h?: number;
};

export const DEXSCREENER_BATCH_SIZE = 30;
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
    if (key && !quotes[key] && validPrice(quote.priceUsd) && quote.reputation === "ok") {
      quotes[key] = { priceUsd: quote.priceUsd, source: "blockscout", verified: true };
    }
  }
  return quotes;
}

export function unresolvedEligibleAddresses(
  tokens: Array<{ address?: unknown; source?: unknown }>,
  quotes: Record<string, PriceQuote>,
  wethAddress: string,
  blockscoutQuotes?: Record<string, BlockscoutQuote>,
): string[] {
  const weth = wethAddress.toLowerCase();
  return [...new Set(tokens.flatMap((token) => {
    const address = normalizeTokenAddress(token.address);
    const sources = typeof token.source === "string" ? token.source.split(",") : [];
    const reputation = address ? blockscoutQuotes?.[address]?.reputation : undefined;
    return address && !quotes[address] && address !== weth && sources.includes("blockscout-balances")
      && reputation === "ok" ? [address] : [];
  }))];
}

export function marketEvidenceAddresses(
  tokens: Array<{ address?: unknown; source?: unknown }>,
  blockscoutQuotes: Record<string, BlockscoutQuote> | undefined,
  wethAddress: string,
): string[] {
  const weth = wethAddress.toLowerCase();
  return [...new Set(tokens.flatMap((token) => {
    const address = normalizeTokenAddress(token.address);
    const sources = typeof token.source === "string" ? token.source.split(",") : [];
    const quote = address ? blockscoutQuotes?.[address] : undefined;
    return address && address !== weth && sources.includes("blockscout-balances")
      && quote?.reputation === "ok" && validPrice(quote.priceUsd)
      && typeof quote.volume24h === "number" && quote.volume24h >= MIN_BLOCKSCOUT_VOLUME_24H_USD
      ? [address]
      : [];
  }))];
}

type DexPair = {
  chainId?: unknown;
  baseToken?: { address?: unknown };
  priceUsd?: unknown;
  liquidity?: { usd?: unknown };
};

export function qualifyingDexScreenerQuotes(requestedAddresses: string[], pairs: unknown): Record<string, PriceQuote> {
  const requested = new Set(requestedAddresses.map(normalizeTokenAddress).filter((address): address is string => !!address));
  const selected = new Map<string, { priceUsd: number; liquidityUsd: number }>();
  if (!Array.isArray(pairs)) return {};
  for (const pair of pairs as DexPair[]) {
    const address = normalizeTokenAddress(pair?.baseToken?.address);
    const priceUsd = Number(pair?.priceUsd);
    const liquidityUsd = Number(pair?.liquidity?.usd);
    if (pair?.chainId !== "base" || !address || !requested.has(address)
      || !Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(liquidityUsd) || liquidityUsd <= 0) continue;
    const existing = selected.get(address);
    if (!existing || liquidityUsd > existing.liquidityUsd) selected.set(address, { priceUsd, liquidityUsd });
  }
  return Object.fromEntries([...selected].map(([address, quote]) => [address, {
    priceUsd: quote.priceUsd, source: "dexscreener" as const, verified: true,
  }]));
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
