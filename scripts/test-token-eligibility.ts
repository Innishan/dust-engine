import assert from "node:assert/strict";
import { evaluateCleanDustEligibility } from "../src/tokenEligibility";
import { MAX_CORROBORATING_PRICE_RATIO } from "../src/marketEvidence";
import type { GeckoMarketQuote, GoPlusRisk, PoolIdentity } from "../src/marketEvidence";
import type { PriceQuote } from "../src/tokenPricing";

const token = "0x1111111111111111111111111111111111111111";
const quote = "0x2222222222222222222222222222222222222222";
const poolAddress = "0x3333333333333333333333333333333333333333";
const now = 1_800_000_000_000;
const dex: PriceQuote = { source: "dexscreener", verified: false, chainId: "8453", baseTokenAddress: token, poolAddress, quoteTokenAddress: quote, priceUsd: 2, liquidityUsd: 1_000, volume24hUsd: 1_000, buys24h: 5, sells24h: 5, fetchedAt: now };
const gecko: GeckoMarketQuote = { chainId: "8453", tokenAddress: token, poolAddress, baseTokenAddress: token, quoteTokenAddress: quote, priceUsd: 2, liquidityUsd: 1_000, volume24hUsd: 1_000, buys24h: 5, sells24h: 5, fetchedAt: now };
const pool: PoolIdentity = { chainId: 8453, token0: token, token1: quote, verified: true };
const risk: GoPlusRisk = { status: "available", fields: { is_honeypot: "0" }, fetchedAt: now };
const evaluate = (overrides: Record<string, unknown> = {}) => evaluateCleanDustEligibility({ address: token, canonicalAddresses: [], dex, gecko, pool, risk, now, ...overrides });

assert.deepEqual(evaluate(), { eligible: true, reason: "corroborated_market_evidence", riskStatus: "no_explicit_adverse_flag" }, "inclusive thresholds pass");
assert.equal(evaluate({ address: "not-an-address" }).reason, "invalid_token_address");
assert.equal(evaluate({ gecko: undefined }).reason, "missing_geckoterminal_evidence");
assert.equal(evaluate({ dex: undefined }).reason, "missing_dexscreener_evidence");
assert.equal(evaluate({ pool: undefined }).reason, "base_rpc_pool_verification_unavailable");
assert.equal(evaluate({ gecko: { ...gecko, chainId: "1" } }).reason, "wrong_chain");
assert.equal(evaluate({ dex: { ...dex, chainId: "1" } }).reason, "wrong_chain");
assert.equal(evaluate({ gecko: { ...gecko, tokenAddress: quote } }).reason, "pool_or_token_mismatch");
assert.equal(evaluate({ gecko: { ...gecko, poolAddress: quote } }).reason, "pool_or_token_mismatch");
assert.equal(evaluate({ dex: { ...dex, baseTokenAddress: quote } }).reason, "pool_or_token_mismatch");
assert.equal(evaluate({ dex: { ...dex, poolAddress: quote } }).reason, "pool_or_token_mismatch");
assert.equal(evaluate({ dex: { ...dex, quoteTokenAddress: token } }).reason, "pool_or_token_mismatch");
assert.equal(evaluate({ pool: { ...pool, token1: "0x4444444444444444444444444444444444444444" } }).reason, "rpc_pool_pair_mismatch");
assert.equal(evaluate({ pool: { ...pool, verified: false } }).reason, "rpc_pool_pair_mismatch");
assert.equal(evaluate({ gecko: { ...gecko, priceUsd: dex.priceUsd * MAX_CORROBORATING_PRICE_RATIO } }).eligible, true, "exact 25 percent boundary passes");
assert.equal(evaluate({ gecko: { ...gecko, priceUsd: dex.priceUsd * 1.25001 } }).reason, "conflicting_market_prices");
assert.equal(evaluate({ dex: { ...dex, liquidityUsd: 999.99 } }).reason, "insufficient_or_malformed_market_activity");
assert.equal(evaluate({ gecko: { ...gecko, volume24hUsd: 999 } }).reason, "insufficient_or_malformed_market_activity");
assert.equal(evaluate({ dex: { ...dex, sells24h: 0 } }).reason, "insufficient_or_malformed_market_activity");
assert.equal(evaluate({ gecko: { ...gecko, priceUsd: Number.NaN } }).reason, "insufficient_or_malformed_market_activity");
assert.equal(evaluate({ gecko: { ...gecko, fetchedAt: now - 300_001 } }).reason, "stale_or_invalid_evidence");
assert.equal(evaluate({ dex: { ...dex, fetchedAt: now - 300_001 } }).reason, "stale_or_invalid_evidence");
assert.equal(evaluate({ risk: { status: "unavailable", fields: {} } }).reason, "goplus_risk_evidence_unavailable");
assert.equal(evaluate({ risk: { ...risk, fields: { is_honeypot: "1" } } }).reason, "adverse_goplus_finding");
assert.equal(evaluate({ risk: { ...risk, fields: { is_blacklisted: "1" } } }).eligible, true, "blacklist capability alone does not reject otherwise eligible evidence");
assert.equal(evaluate({ risk: { ...risk, fields: { is_blacklisted: "true" } } }).eligible, true, "boolean-string blacklist capability alone does not reject any token");
assert.equal(evaluate({ risk: { ...risk, fields: { is_blacklisted: "0" } } }).eligible, true);
assert.equal(evaluate({ risk: { ...risk, fields: { is_blacklisted: "false" } } }).eligible, true);
const absentBlacklist = evaluate({ risk: { ...risk, fields: {} } });
assert.equal(absentBlacklist.eligible, true);
assert.equal("riskStatus" in absentBlacklist ? absentBlacklist.riskStatus : undefined, "unknown", "absent flags stay unknown");
const mintableOnly = evaluate({ risk: { ...risk, fields: { is_mintable: "1" } } });
assert.equal(mintableOnly.eligible, true, "is_mintable is not an explicit rejection trigger in the current policy");
assert.equal("riskStatus" in mintableOnly ? mintableOnly.riskStatus : undefined, "unknown");
assert.equal(evaluate({ risk: { ...risk, fields: { is_open_source: "0" } } }).reason, "adverse_goplus_finding");
assert.equal(evaluate({ risk: { ...risk, fields: { cannot_sell_all: "1" } } }).reason, "adverse_goplus_finding");
assert.equal(evaluate({ risk: { ...risk, fields: { buy_tax: "0.11" } } }).reason, "adverse_goplus_finding");
assert.deepEqual(evaluateCleanDustEligibility({ address: token, canonicalAddresses: [token] }), { eligible: true, reason: "canonical" });
const unknownRiskResult = evaluate({ risk: { status: "available", fields: {}, fetchedAt: now } });
assert.equal("riskStatus" in unknownRiskResult ? unknownRiskResult.riskStatus : undefined, "unknown", "missing flags remain unknown, not safe");
const malformedRiskResult = evaluate({ risk: { status: "available", fields: { buy_tax: "unknown" }, fetchedAt: now } });
assert.equal(malformedRiskResult.reason, "malformed_goplus_risk_data", "malformed risk field fails closed");
assert.equal(evaluate({ risk: { status: "available", fields: { is_honeypot: "maybe" }, fetchedAt: now } }).reason, "malformed_goplus_risk_data");
assert.equal(evaluate({ risk: { status: "available", fields: { is_honeypot: "TRUE-ish" }, fetchedAt: now } }).reason, "malformed_goplus_risk_data", "unrecognized binary strings fail closed");
assert.equal(evaluate({ risk: { status: "available", fields: { buy_tax: "not-a-number" }, fetchedAt: now } }).reason, "malformed_goplus_risk_data", "malformed tax strings fail closed");
assert.equal(evaluate({ risk: { status: "available", fields: { sell_tax: "1.01" }, fetchedAt: now } }).reason, "malformed_goplus_risk_data", "taxes above the existing allowed range fail closed");
assert.equal(evaluate({ risk: { status: "available", fields: { is_honeypot: "true", buy_tax: "0.1" }, fetchedAt: now } }).reason, "adverse_goplus_finding", "valid existing string forms retain adverse-flag and 10% tax semantics");
for (const walletCase of [
  "0x696f9436b67233384889472cd7cd58a6fb5df4f1", // AVNT
  "0x5b2193fdc451c1f847be09ca9d13a4bf60f8c86b", // UP
  "0x1111111111166b7fe7bd91427724b487980afc69", // ZORA
]) {
  const mockResult = evaluateCleanDustEligibility({
    address: walletCase, canonicalAddresses: [], now,
    dex: { ...dex, baseTokenAddress: walletCase, poolAddress, quoteTokenAddress: quote },
    gecko: { ...gecko, tokenAddress: walletCase, baseTokenAddress: walletCase },
    pool: { ...pool, token0: walletCase, token1: quote },
    risk,
  });
  assert.equal(mockResult.eligible, true, "each supplied wallet case follows the generic evidence policy with complete mock evidence");
}
console.log("token eligibility tests passed");
