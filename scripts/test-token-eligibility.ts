import assert from "node:assert/strict";
import { evaluateCleanDustEligibility } from "../src/tokenEligibility";

const canonicalUsdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const aero = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
const smallCap = "0x1111111111111111111111111111111111111111";
const spam = "0x2222222222222222222222222222222222222222";

const trustedBlockscout = { priceUsd: 0.05, reputation: "ok", volume24h: 25_000 } as const;
const agreeingDex = { priceUsd: 0.051, source: "dexscreener" as const, verified: true };

function run() {
  // Contract address, not a symbol or name, is the canonical identity.
  assert.deepEqual(evaluateCleanDustEligibility({
    address: `0x${canonicalUsdc.slice(2).toUpperCase()}`, canonicalAddresses: [canonicalUsdc],
  }), { eligible: true, reason: "canonical" }, "USDC remains eligible by its canonical contract address");

  assert.deepEqual(evaluateCleanDustEligibility({
    address: aero, canonicalAddresses: [], blockscoutQuote: trustedBlockscout, dexScreenerQuote: agreeingDex,
  }), { eligible: true, reason: "trusted_blockscout_market" }, "AERO can qualify through objective market evidence");

  // A legitimately small wallet balance can pass when independent market evidence exists.
  assert.deepEqual(evaluateCleanDustEligibility({
    address: smallCap, canonicalAddresses: [], blockscoutQuote: trustedBlockscout, dexScreenerQuote: agreeingDex,
  }), { eligible: true, reason: "trusted_blockscout_market" });

  assert.equal(evaluateCleanDustEligibility({
    address: spam, canonicalAddresses: [], blockscoutQuote: { priceUsd: 1, reputation: "scam", volume24h: 1_000_000 }, dexScreenerQuote: { priceUsd: 1, source: "dexscreener", verified: true },
  }).eligible, false, "an explicit scam reputation fails");

  assert.equal(evaluateCleanDustEligibility({
    address: spam, canonicalAddresses: [], blockscoutQuote: { priceUsd: 1, reputation: "unknown", volume24h: 1_000_000 },
  }).eligible, false, "an unknown reputation fails closed");

  assert.equal(evaluateCleanDustEligibility({
    address: spam, canonicalAddresses: [], blockscoutQuote: { priceUsd: 1, volume24h: 1_000_000 },
  }).eligible, false, "a missing reputation fails closed");

  assert.equal(evaluateCleanDustEligibility({
    address: spam, canonicalAddresses: [], dexScreenerQuote: agreeingDex,
  }).eligible, false, "a price or DEX pool alone cannot establish eligibility");

  assert.equal(evaluateCleanDustEligibility({
    address: spam, canonicalAddresses: [], blockscoutQuote: { reputation: "ok", volume24h: 1_000_000 },
  }).eligible, false, "a missing Blockscout exchange rate is insufficient evidence");

  assert.equal(evaluateCleanDustEligibility({
    address: spam, canonicalAddresses: [], blockscoutQuote: { priceUsd: 0.05, reputation: "ok", volume24h: 999 },
  }).eligible, false, "a weak-evidence spam candidate with immaterial reported volume fails");

  assert.equal(evaluateCleanDustEligibility({
    address: spam, canonicalAddresses: [], blockscoutQuote: trustedBlockscout, dexScreenerQuote: { priceUsd: 5, source: "dexscreener", verified: true },
  }).reason, "conflicting_market_prices", "conflicting sources fail closed");

  // The function never reads a symbol or token name, so unusual branding is not a rejection signal.
  assert.equal(evaluateCleanDustEligibility({
    address: smallCap, canonicalAddresses: [], blockscoutQuote: trustedBlockscout, dexScreenerQuote: agreeingDex,
  }).eligible, true);

  console.log("token eligibility tests passed");
}

run();
