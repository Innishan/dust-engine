import { evaluateMarketEvidence, type MarketEvidenceInput, type MarketEligibility } from "./marketEvidence";

export type TokenEligibility = MarketEligibility | { eligible: true; reason: "canonical" };

export function evaluateCleanDustEligibility(input: MarketEvidenceInput & { canonicalAddresses: Iterable<string> }): TokenEligibility {
  const token = typeof input.address === "string" ? input.address.toLowerCase() : "";
  const canonical = new Set([...input.canonicalAddresses].map((address) => address.toLowerCase()));
  // Existing canonical-token pathway is preserved. Non-canonical tokens must
  // satisfy the complete independent market, RPC, and risk evidence policy.
  if (/^0x[0-9a-f]{40}$/.test(token) && canonical.has(token)) return { eligible: true, reason: "canonical" };
  return evaluateMarketEvidence(input);
}
