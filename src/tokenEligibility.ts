import type { BlockscoutQuote, PriceQuote } from "./tokenPricing";

// This is a market-evidence threshold, not a minimum token balance or liquidity rule.
// It keeps a priced but unsupported airdrop out of the default Clean Dust list while
// allowing genuinely small wallet balances to remain eligible.
export const MIN_BLOCKSCOUT_VOLUME_24H_USD = 1_000;
export const MAX_CORROBORATING_PRICE_RATIO = 1.25;

export type TokenEligibility = {
  eligible: boolean;
  reason:
    | "canonical"
    | "trusted_blockscout_market"
    | "missing_blockscout_market_evidence"
    | "untrusted_blockscout_reputation"
    | "insufficient_blockscout_volume"
    | "conflicting_market_prices";
};

function normalizedAddress(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : undefined;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function pricesAgree(left: number, right: number): boolean {
  return Math.max(left, right) / Math.min(left, right) <= MAX_CORROBORATING_PRICE_RATIO;
}

export function evaluateCleanDustEligibility({
  address,
  canonicalAddresses,
  blockscoutQuote,
  dexScreenerQuote,
}: {
  address: unknown;
  canonicalAddresses: Iterable<string>;
  blockscoutQuote?: BlockscoutQuote;
  dexScreenerQuote?: PriceQuote;
}): TokenEligibility {
  const tokenAddress = normalizedAddress(address);
  const canonical = new Set([...canonicalAddresses].map((candidate) => candidate.toLowerCase()));
  if (tokenAddress && canonical.has(tokenAddress)) return { eligible: true, reason: "canonical" };

  if (blockscoutQuote?.reputation !== "ok") {
    return { eligible: false, reason: "untrusted_blockscout_reputation" };
  }
  if (!positiveFinite(blockscoutQuote.priceUsd)) {
    return { eligible: false, reason: "missing_blockscout_market_evidence" };
  }
  if (!positiveFinite(blockscoutQuote.volume24h) || blockscoutQuote.volume24h < MIN_BLOCKSCOUT_VOLUME_24H_USD) {
    return { eligible: false, reason: "insufficient_blockscout_volume" };
  }
  if (dexScreenerQuote && !pricesAgree(blockscoutQuote.priceUsd, dexScreenerQuote.priceUsd)) {
    return { eligible: false, reason: "conflicting_market_prices" };
  }
  return { eligible: true, reason: "trusted_blockscout_market" };
}
