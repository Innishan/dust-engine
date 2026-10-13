import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  diagnoseCleanDustScan,
  diagnoseDustToken,
  isDetectedDust,
  isInitiallySelectedDust,
  type DetectableDustToken,
} from "../src/cleanDustDetection";
import { diagnoseRouteQuote } from "../src/executionQuote";

const eligibleDust: DetectableDustToken = {
  address: "0x1111111111111111111111111111111111111111",
  symbol: "MARKET",
  decimals: 18,
  balance: 10n ** 18n,
  formattedBalance: "1",
  priceUsd: 0.2,
  valueUsd: 0.2,
  priceSource: "corroborated_market",
  priceEvidenceStatus: "market_corroborated",
  isVerified: true,
  isEligible: true,
  eligibilityReason: "trusted_blockscout_market",
};

function run() {
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const simulationFailureGate = appSource.indexOf('throw new Error("Clean Dust batch simulation failed")');
  const contractSubmission = appSource.indexOf("const hash = await writeContractAsync", simulationFailureGate);
  assert.ok(simulationFailureGate >= 0 && contractSubmission > simulationFailureGate,
    "a failed batch simulation throws before wallet contract submission");

  assert.equal(isDetectedDust(eligibleDust, 3), true, "eligible, verified assets under the dust ceiling are detected");
  const atThreshold = { ...eligibleDust, valueUsd: 3 };
  assert.equal(isDetectedDust(atThreshold, 3), true, "the inclusive dust ceiling detects an exact-boundary token");
  assert.equal(isInitiallySelectedDust(atThreshold, 3), true, "an exact-boundary detected token is initially selected");
  assert.equal(isInitiallySelectedDust({ ...atThreshold, balance: 0n }, 3), false, "zero balances are not initially selected");
  assert.equal(isInitiallySelectedDust({ ...atThreshold, isEligible: false }, 3), false, "ineligible tokens are not initially selected");
  assert.equal(isInitiallySelectedDust({ ...atThreshold, isVerified: false }, 3), false, "unverified prices are not initially selected");
  assert.equal(isInitiallySelectedDust({ ...eligibleDust, valueUsd: 0.009 }, 3), false, "values below the existing minimum are not initially selected");
  assert.equal(isDetectedDust({ ...eligibleDust, valueUsd: 13.0805 }, 3), false, "eligible assets over the ceiling are not dust");
  assert.ok(diagnoseDustToken({ ...eligibleDust, valueUsd: 13.0805 }, 3).rejectionReasons.includes("above_dust_threshold"));

  const indicativeDexOnly: DetectableDustToken = {
    ...eligibleDust,
    address: "0x696f9436b67233384889472cd7cd58a6fb5df4f1",
    symbol: "AVNT",
    valueUsd: 0.1186,
    priceSource: "dexscreener",
    priceEvidenceStatus: "indicative",
    isVerified: false,
    isEligible: false,
    eligibilityReason: "missing_blockscout_market_evidence",
  };
  const dexDiagnosis = diagnoseDustToken(indicativeDexOnly, 3);
  assert.equal(dexDiagnosis.included, false, "indicative DexScreener pricing alone never admits a token");
  assert.ok(dexDiagnosis.rejectionReasons.includes("ineligible:missing_blockscout_market_evidence"));
  assert.ok(dexDiagnosis.rejectionReasons.includes("price_not_accepted_for_dust"));
  assert.equal(dexDiagnosis.priceEvidenceStatus, "indicative");
  assert.equal(dexDiagnosis.priceAcceptedForDust, false);
  assert.equal(dexDiagnosis.executionPriceVerified, false, "market scan evidence is not execution-route verification");
  assert.equal(dexDiagnosis.executionQuoteStatus, "not_requested_during_scan");
  const missingPrice = diagnoseDustToken({ ...indicativeDexOnly, priceUsd: 0, valueUsd: 0, priceEvidenceStatus: "unavailable" }, 3);
  assert.equal(missingPrice.priceEvidenceStatus, "unavailable");
  assert.ok(missingPrice.rejectionReasons.includes("missing_price"));
  assert.ok(missingPrice.rejectionReasons.includes("price_not_accepted_for_dust"));
  const malformedPrice = diagnoseDustToken({ ...indicativeDexOnly, priceUsd: Number.NaN, valueUsd: Number.NaN }, 3);
  assert.equal(malformedPrice.priceEvidenceStatus, "unavailable");
  const legacyAcceptedIndicative = diagnoseDustToken({
    ...eligibleDust,
    priceSource: "coingecko",
    priceEvidenceStatus: "indicative",
  }, 3);
  assert.equal(legacyAcceptedIndicative.priceEvidenceStatus, "indicative");
  assert.equal(legacyAcceptedIndicative.priceAcceptedForDust, true, "legacy admission behavior is exposed separately from evidence classification");
  assert.equal(legacyAcceptedIndicative.executionPriceVerified, false);

  assert.equal(isDetectedDust({ ...eligibleDust, priceUsd: 0.2, valueUsd: 0.2 }, 3), true,
    "the default filter uses normalized valueUsd, metadata, and the same eligibility fields as the token row");
  const scan = diagnoseCleanDustScan(4, 4, [eligibleDust, indicativeDexOnly], 3);
  assert.deepEqual({
    positive: scan.positiveVerifiedBalance,
    metadata: scan.validMetadata,
    priced: scan.priceAvailable,
    within: scan.withinDustThreshold,
    eligible: scan.eligible,
    verified: scan.executionPriceVerified,
    detected: scan.detectedDust,
  }, { positive: 4, metadata: 4, priced: 2, within: 2, eligible: 1, verified: 0, detected: 1 });
  assert.equal(scan.marketCorroboratedPrice, 1);
  assert.equal(scan.indicativePrice, 1);
  assert.equal(scan.priceAcceptedForDust, 1);
  assert.equal(scan.executionQuoteStatus, "not_requested_during_scan");
  const outcomeScan = diagnoseCleanDustScan(8, 8, [
    { ...eligibleDust, balance: 0n },
    { ...eligibleDust, symbol: "", isEligible: false },
    { ...eligibleDust, priceUsd: 0, valueUsd: 0 },
    { ...eligibleDust, valueUsd: 0.009 },
    { ...eligibleDust, valueUsd: 3.01 },
    { ...eligibleDust, isEligible: false },
    { ...eligibleDust, priceAcceptedForDust: false },
    eligibleDust,
  ], 3);
  assert.deepEqual(outcomeScan.primaryOutcomeCounts, {
    balance_unavailable_or_non_positive: 1,
    metadata_invalid_or_unavailable: 1,
    price_unavailable: 1,
    value_below_minimum: 1,
    value_above_threshold: 1,
    token_ineligible: 1,
    price_not_accepted: 1,
    detected_dust: 1,
  }, "each record receives one primary outcome in pipeline gate order");
  assert.equal(Object.values(outcomeScan.primaryOutcomeCounts).reduce((sum, count) => sum + count, 0), outcomeScan.evaluatedRecords,
    "mutually exclusive outcome counts reconcile exactly with evaluated records");
  assert.equal(outcomeScan.independentRejectionReasonCounts["missing_price"], 1,
    "independent rejection details remain separately available");
  assert.equal(outcomeScan.independentRejectionReasonCounts["ineligible:other"], 2,
    "unknown eligibility labels are collapsed to a bounded sanitized category");
  assert.equal(outcomeScan.independentRejectionReasonCounts["ineligible:trusted_blockscout_market"], undefined);

  const localPriceDiagnosis = diagnoseDustToken({ ...eligibleDust, priceSource: "local", priceEvidenceStatus: "locally_configured" }, 3);
  assert.equal(localPriceDiagnosis.priceEvidenceStatus, "locally_configured");
  assert.equal(localPriceDiagnosis.executionPriceVerified, false);

  const route = {
    fromChainId: 8453, toChainId: 8453, fromAmount: "1000", toAmount: "500", toAmountMin: "450",
    fromToken: { address: indicativeDexOnly.address }, toToken: { address: "0x4200000000000000000000000000000000000006" },
    toAddress: "0x9999999999999999999999999999999999999999",
  };
  const step = { action: { toAddress: route.toAddress } };
  const transactionRequest = { to: "0x8888888888888888888888888888888888888888", data: "0x1234", value: "0" };
  const routeInput = {
    route, step, transactionRequest, requestedInputAmount: "1000", expectedInputToken: indicativeDexOnly.address,
    expectedOutputToken: "0x4200000000000000000000000000000000000006", expectedRecipient: route.toAddress,
  };
  assert.deepEqual(diagnoseRouteQuote(routeInput), {
    status: "route_quote_validated", inputAmount: "1000", outputAmount: "500", minimumOutputAmount: "450",
  }, "route verification describes the actual LI.FI input/output and minimum output");
  assert.equal(diagnoseRouteQuote({ ...routeInput, route: undefined }).status, "route_unavailable");
  assert.equal(diagnoseRouteQuote({ ...routeInput, requestedInputAmount: "1001" }).status, "route_input_mismatch");
  assert.equal(diagnoseRouteQuote({ ...routeInput, route: { ...route, toAmount: "0", toAmountMin: "0" } }).status, "route_output_invalid");
  assert.equal(diagnoseRouteQuote({ ...routeInput, route: { ...route, toAmount: "50", toAmountMin: "51" } }).status, "route_output_invalid");
  assert.equal(diagnoseRouteQuote({ ...routeInput, route: { ...route, toToken: { address: indicativeDexOnly.address } } }).status, "route_token_mismatch");
  assert.equal(diagnoseRouteQuote({ ...routeInput, step: { action: { toAddress: indicativeDexOnly.address } } }).status, "route_recipient_mismatch");
  assert.equal(diagnoseRouteQuote({ ...routeInput, transactionRequest: { ...transactionRequest, data: "0x" } }).status, "transaction_data_invalid");
  assert.equal(diagnoseRouteQuote({ ...routeInput, transactionRequest: { ...transactionRequest, value: "0x" } }).status, "transaction_data_invalid");
  assert.equal(diagnoseRouteQuote({ ...routeInput, transactionRequest: { ...transactionRequest, to: "bad" } }).status, "transaction_data_invalid");
  assert.equal(diagnoseRouteQuote({ ...routeInput, transactionRequest: { ...transactionRequest, data: "0x12z4" } }).status, "transaction_data_invalid");
  assert.equal(diagnoseRouteQuote({ ...routeInput, route: { ...route, fromChainId: 1 } }).status, "route_token_mismatch");
  console.log("clean dust detection tests passed");
}

run();
