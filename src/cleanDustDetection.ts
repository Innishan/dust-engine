export const MIN_DETECTED_DUST_VALUE_USD = 0.01;

export type DetectableDustToken = {
  address: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  formattedBalance: string;
  priceUsd: number;
  valueUsd: number;
  priceSource?: string;
  priceEvidenceStatus?: "locally_configured" | "market_corroborated" | "indicative" | "unavailable";
  priceAcceptedForDust?: boolean;
  /** Legacy compatibility flag for scan-price admission; never means an execution route was verified. */
  isVerified: boolean;
  isEligible: boolean;
  eligibilityReason?: string;
};

export type DustTokenDiagnosis = {
  address: string;
  symbol: string;
  balance: string;
  priceUsd: number;
  valueUsd: number;
  priceSource: string;
  priceEvidenceStatus: "locally_configured" | "market_corroborated" | "indicative" | "unavailable";
  priceAcceptedForDust: boolean;
  eligible: boolean;
  /** Legacy compatibility field. Scanning does not request or verify execution routes. */
  executionPriceVerified: boolean;
  executionQuoteStatus: "not_requested_during_scan";
  withinDustThreshold: boolean;
  primaryOutcome: CleanDustPrimaryOutcome;
  eligibilityReason?: string;
  included: boolean;
  rejectionReasons: string[];
};

export type CleanDustPrimaryOutcome =
  | "balance_unavailable_or_non_positive"
  | "metadata_invalid_or_unavailable"
  | "price_unavailable"
  | "value_below_minimum"
  | "value_above_threshold"
  | "token_ineligible"
  | "price_not_accepted"
  | "detected_dust";

export type CleanDustOutcomeCounts = Record<CleanDustPrimaryOutcome, number>;
const KNOWN_ELIGIBILITY_REASONS = new Set([
  "canonical", "invalid_token_address", "missing_dexscreener_evidence", "missing_geckoterminal_evidence",
  "base_rpc_pool_verification_unavailable", "malformed_goplus_risk_data", "goplus_risk_evidence_unavailable",
  "adverse_goplus_finding", "wrong_chain", "pool_or_token_mismatch", "rpc_pool_pair_mismatch",
  "stale_or_invalid_evidence", "insufficient_or_malformed_market_activity", "conflicting_market_prices",
]);

export type CleanDustScanDiagnosis = {
  positiveVerifiedBalance: number;
  validMetadata: number;
  priceAvailable: number;
  locallyConfiguredPrice: number;
  marketCorroboratedPrice: number;
  indicativePrice: number;
  withinDustThreshold: number;
  eligible: number;
  priceAcceptedForDust: number;
  /** Legacy compatibility field. Always zero because scan does not fetch LI.FI routes. */
  executionPriceVerified: number;
  executionQuoteStatus: "not_requested_during_scan";
  detectedDust: number;
  evaluatedRecords: number;
  primaryOutcomeCounts: CleanDustOutcomeCounts;
  independentRejectionReasonCounts: Record<string, number>;
  rejectedTokens: DustTokenDiagnosis[];
};

function priceEvidenceStatus(token: DetectableDustToken): DustTokenDiagnosis["priceEvidenceStatus"] {
  if (!Number.isFinite(token.priceUsd) || token.priceUsd <= 0) return "unavailable";
  if (token.priceEvidenceStatus) return token.priceEvidenceStatus;
  if (token.priceSource === "local") return "locally_configured";
  if (token.priceSource === "corroborated_market") return "market_corroborated";
  return "indicative";
}

export function diagnoseDustToken(token: DetectableDustToken, dustThreshold: number): DustTokenDiagnosis {
  const priceAcceptedForDust = token.priceAcceptedForDust ?? token.isVerified;
  const rejectionReasons: string[] = [];
  if (token.balance <= 0n) rejectionReasons.push("no_positive_verified_balance");
  if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255 || !token.symbol) {
    rejectionReasons.push("invalid_metadata");
  }
  if (!Number.isFinite(token.priceUsd) || token.priceUsd <= 0) rejectionReasons.push("missing_price");
  if (!Number.isFinite(token.valueUsd) || token.valueUsd < MIN_DETECTED_DUST_VALUE_USD) {
    rejectionReasons.push("below_minimum_dust_value");
  } else if (token.valueUsd > dustThreshold) {
    rejectionReasons.push("above_dust_threshold");
  }
  if (!token.isEligible) rejectionReasons.push(`ineligible:${token.eligibilityReason || "unknown"}`);
  if (!priceAcceptedForDust) rejectionReasons.push("price_not_accepted_for_dust");
  // Preserve the final filter's current gate order while assigning exactly
  // one primary outcome. Secondary failures remain in rejectionReasons.
  const primaryOutcome: CleanDustPrimaryOutcome = token.balance <= 0n
    ? "balance_unavailable_or_non_positive"
    : !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255 || !token.symbol
      ? "metadata_invalid_or_unavailable"
      : !Number.isFinite(token.priceUsd) || token.priceUsd <= 0
        ? "price_unavailable"
        : !Number.isFinite(token.valueUsd) || token.valueUsd < MIN_DETECTED_DUST_VALUE_USD
          ? "value_below_minimum"
          : token.valueUsd > dustThreshold
            ? "value_above_threshold"
            : !token.isEligible
              ? "token_ineligible"
              : !priceAcceptedForDust
                ? "price_not_accepted"
                : "detected_dust";
  return {
    address: token.address,
    symbol: token.symbol,
    balance: token.formattedBalance,
    priceUsd: token.priceUsd,
    valueUsd: token.valueUsd,
    priceSource: token.priceSource || "none",
    priceEvidenceStatus: priceEvidenceStatus(token),
    priceAcceptedForDust,
    eligible: token.isEligible,
    executionPriceVerified: false,
    executionQuoteStatus: "not_requested_during_scan",
    withinDustThreshold: Number.isFinite(token.valueUsd)
      && token.valueUsd >= MIN_DETECTED_DUST_VALUE_USD && token.valueUsd <= dustThreshold,
    primaryOutcome,
    ...(token.eligibilityReason ? { eligibilityReason: token.eligibilityReason } : {}),
    included: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

export function isDetectedDust(token: DetectableDustToken, dustThreshold: number): boolean {
  return diagnoseDustToken(token, dustThreshold).included;
}

export function isInitiallySelectedDust(token: DetectableDustToken, dustThreshold: number): boolean {
  return token.balance > 0n
    && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 255 && !!token.symbol
    && Number.isFinite(token.valueUsd) && token.valueUsd >= MIN_DETECTED_DUST_VALUE_USD && token.valueUsd <= dustThreshold
    && token.isEligible && (token.priceAcceptedForDust ?? token.isVerified);
}

export function diagnoseCleanDustScan(
  positiveVerifiedBalance: number,
  validMetadata: number,
  tokens: DetectableDustToken[],
  dustThreshold: number,
): CleanDustScanDiagnosis {
  const diagnoses = tokens.map((token) => diagnoseDustToken(token, dustThreshold));
  const primaryOutcomeCounts: CleanDustOutcomeCounts = {
    balance_unavailable_or_non_positive: 0,
    metadata_invalid_or_unavailable: 0,
    price_unavailable: 0,
    value_below_minimum: 0,
    value_above_threshold: 0,
    token_ineligible: 0,
    price_not_accepted: 0,
    detected_dust: 0,
  };
  const independentRejectionReasonCounts: Record<string, number> = {};
  for (const diagnosis of diagnoses) {
    primaryOutcomeCounts[diagnosis.primaryOutcome] += 1;
    for (const reason of diagnosis.rejectionReasons) {
      const eligibilityReason = diagnosis.eligibilityReason || "unknown";
      const safeReason = reason.startsWith("ineligible:")
        ? `ineligible:${KNOWN_ELIGIBILITY_REASONS.has(eligibilityReason) ? eligibilityReason : "other"}`
        : reason;
      independentRejectionReasonCounts[safeReason] = (independentRejectionReasonCounts[safeReason] ?? 0) + 1;
    }
  }
  return {
    positiveVerifiedBalance,
    validMetadata,
    priceAvailable: tokens.filter((token) => Number.isFinite(token.priceUsd) && token.priceUsd > 0).length,
    locallyConfiguredPrice: tokens.filter((token) => priceEvidenceStatus(token) === "locally_configured").length,
    marketCorroboratedPrice: tokens.filter((token) => priceEvidenceStatus(token) === "market_corroborated").length,
    indicativePrice: tokens.filter((token) => priceEvidenceStatus(token) === "indicative").length,
    withinDustThreshold: tokens.filter((token) => Number.isFinite(token.valueUsd)
      && token.valueUsd >= MIN_DETECTED_DUST_VALUE_USD && token.valueUsd <= dustThreshold).length,
    eligible: tokens.filter((token) => token.isEligible).length,
    priceAcceptedForDust: tokens.filter((token) => token.priceAcceptedForDust ?? token.isVerified).length,
    executionPriceVerified: 0,
    executionQuoteStatus: "not_requested_during_scan",
    detectedDust: diagnoses.filter((diagnosis) => diagnosis.included).length,
    evaluatedRecords: diagnoses.length,
    primaryOutcomeCounts,
    independentRejectionReasonCounts,
    rejectedTokens: diagnoses.filter((diagnosis) => !diagnosis.included),
  };
}
