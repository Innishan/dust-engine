import assert from "node:assert/strict";
import { blockscoutQuotesFromBalanceItems } from "../server/tokenDiscovery";
import { MARKET_EVIDENCE_LIMIT } from "../src/marketEvidence";
import {
  DEXSCREENER_BATCH_SIZE,
  DEXSCREENER_BASE_URL,
  MAX_DEXSCREENER_POOLS_PER_TOKEN,
  createInitialQuotes,
  dexScreenerChunks,
  fetchDexScreenerQuotes,
  indicativePriceAddresses,
  manualTokenPriceQuote,
  potentialMarketEvidenceAddresses,
  qualifyingMarketEvidencePools,
  qualifyingDexScreenerQuotes,
} from "../src/tokenPricing";

const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const aero = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const other = "0x1111111111111111111111111111111111111111";
const quoteOnly = "0x2222222222222222222222222222222222222222";
const weth = "0x4200000000000000000000000000000000000006";

async function run() {
  assert.deepEqual(manualTokenPriceQuote(usdc, 9, { [usdc]: 1 }), {
    priceUsd: 1, source: "local", verified: true,
  }, "manual addition preserves configured canonical-token pricing");
  assert.deepEqual(manualTokenPriceQuote(other, 9, { [usdc]: 1 }), {
    priceUsd: 9, source: "coingecko", verified: false,
  }, "manual provider pricing remains indicative and cannot be accepted for dust");
  assert.equal(manualTokenPriceQuote(other, 0, { [usdc]: 1 }), undefined,
    "manual addition without an accepted or indicative price remains unavailable");
  // A. Blockscout metadata is retained for every valid ERC-20 balance row, while
  // only a positive exchange rate becomes a usable price.
  const extracted = blockscoutQuotesFromBalanceItems([
    { token: { type: "ERC-20", address_hash: aero, exchange_rate: "0.538953", reputation: "ok", volume_24h: "1234.5" } },
    { token: { type: "ERC-20", address_hash: other, reputation: "ok" } },
    { token: { type: "ERC-20", address_hash: quoteOnly, exchange_rate: 0 } },
    { token: { type: "ERC-20", address_hash: usdc, exchange_rate: Number.NaN } },
    { token: { type: "ERC-721", address_hash: weth, exchange_rate: 1 } },
  ]);
  assert.deepEqual(extracted[aero.toLowerCase()], { priceUsd: 0.538953, reputation: "ok", volume24h: 1234.5 });
  assert.deepEqual(extracted[other], { reputation: "ok" });
  assert.deepEqual(extracted[quoteOnly], {});
  assert.equal(Object.keys(extracted).length, 4);

  // B. Source precedence is strict and unresolved tokens fail closed.
  const quotes = createInitialQuotes({ [usdc]: 1 }, {
    [usdc]: { priceUsd: 0.999747, reputation: "ok" },
    [aero]: { priceUsd: 0.538953, reputation: "ok" },
  });
  assert.equal(quotes[usdc].source, "local");
  assert.equal(quotes[aero.toLowerCase()].source, "blockscout");
  const untrusted = createInitialQuotes({}, { [quoteOnly]: { priceUsd: 1, reputation: "scam" } });
  assert.equal(untrusted[quoteOnly].verified, false, "Blockscout metadata remains indicative regardless of reputation");
  const dex = qualifyingDexScreenerQuotes([other, aero], [
    { chainId: "base", baseToken: { address: other }, priceUsd: "2", liquidity: { usd: 40 } },
    { chainId: "base", baseToken: { address: aero }, priceUsd: "3", liquidity: { usd: 100 } },
  ]);
  for (const [address, quote] of Object.entries(dex)) if (!quotes[address]) quotes[address] = quote;
  assert.equal(quotes[aero.toLowerCase()].source, "blockscout", "DexScreener cannot overwrite Blockscout");
  assert.equal(quotes[other].source, "dexscreener");
  assert.equal(quotes[quoteOnly], undefined, "unresolved token remains unpriced and unverified");

  // C. DexScreener uses the documented Base endpoint and deterministic pair validation.
  const many = Array.from({ length: 61 }, (_, index) => `0x${index.toString(16).padStart(40, "0")}`);
  assert.ok(dexScreenerChunks(many).every((chunk) => chunk.length <= DEXSCREENER_BATCH_SIZE));
  assert.equal(DEXSCREENER_BATCH_SIZE, 30);
  const candidates = qualifyingDexScreenerQuotes([other], [
    { chainId: "ethereum", baseToken: { address: other }, priceUsd: "1", liquidity: { usd: 100 } },
    { chainId: "base", quoteToken: { address: other }, baseToken: { address: quoteOnly }, priceUsd: "1", liquidity: { usd: 100 } },
    { chainId: "base", baseToken: { address: other }, priceUsd: "bad", liquidity: { usd: 100 } },
    { chainId: "base", baseToken: { address: other }, priceUsd: "1", liquidity: { usd: 0 } },
    { chainId: "base", baseToken: { address: other }, priceUsd: "1.5", liquidity: { usd: 20 } },
    { chainId: "base", baseToken: { address: other }, priceUsd: "2.5", liquidity: { usd: 30 } },
  ]);
  assert.equal(candidates[other].priceUsd, 2.5);
  assert.equal(candidates[other].source, "dexscreener");
  assert.equal(candidates[other].verified, false);
  assert.equal(candidates[other].chainId, "8453");
  assert.equal(candidates[other].liquidityUsd, 30);
  assert.ok(Number.isFinite(candidates[other].fetchedAt), "Dex quotes carry a local observation time for freshness gating");
  const avnt = "0x696f9436b67233384889472cd7cd58a6fb5df4f1";
  const avntCandidates = indicativePriceAddresses([
    { address: avnt },
    { address: weth },
  ], weth);
  assert.deepEqual(avntCandidates, [avnt]);
  const avntIndicative = qualifyingDexScreenerQuotes(avntCandidates, [
    { chainId: "base", baseToken: { address: avnt }, quoteToken: { address: usdc }, pairAddress: other, priceUsd: "0.1344", liquidity: { usd: 767042.32 }, volume: { h24: 21_000 }, txns: { h24: { buys: 80, sells: 60 } } },
  ]);
  assert.equal(avntIndicative[avnt].priceUsd, 0.1344);
  assert.equal(avntIndicative[avnt].verified, false, "DexScreener display quotes are never verified prices");
  assert.equal(avntIndicative[avnt].source, "dexscreener");
  assert.deepEqual(potentialMarketEvidenceAddresses([{ address: avnt }], avntIndicative), [avnt]);
  const alternativePool = "0x4444444444444444444444444444444444444444";
  const multiPool = qualifyingDexScreenerQuotes([avnt], [
    { chainId: "base", baseToken: { address: avnt }, quoteToken: { address: usdc }, pairAddress: other, priceUsd: "0.13", liquidity: { usd: 900_000 }, volume: { h24: 8_000 }, txns: { h24: { buys: 3, sells: 2 } } },
    { chainId: "base", baseToken: { address: avnt }, quoteToken: { address: usdc }, pairAddress: alternativePool, priceUsd: "0.131", liquidity: { usd: 8_000 }, volume: { h24: 3_000 }, txns: { h24: { buys: 20, sells: 18 } } },
  ]);
  assert.equal(multiPool[avnt].poolAddress, other, "indicative pricing still uses the most-liquid pool");
  assert.deepEqual(qualifyingMarketEvidencePools(multiPool[avnt]).map((pool) => pool.poolAddress), [alternativePool],
    "an active alternative is selected even when the most-liquid pool fails activity gates");
  assert.deepEqual(potentialMarketEvidenceAddresses([{ address: avnt }], multiPool), [avnt]);
  const noQualifyingPools = qualifyingDexScreenerQuotes([avnt], [
    { chainId: "base", baseToken: { address: avnt }, quoteToken: { address: usdc }, pairAddress: other, priceUsd: "0.13", liquidity: { usd: 900_000 }, volume: { h24: 8_000 }, txns: { h24: { buys: 3, sells: 2 } } },
    { chainId: "base", baseToken: { address: avnt }, quoteToken: { address: usdc }, pairAddress: alternativePool, priceUsd: "0.131", liquidity: { usd: 8_000 }, volume: { h24: 999 }, txns: { h24: { buys: 20, sells: 18 } } },
  ]);
  assert.deepEqual(potentialMarketEvidenceAddresses([{ address: avnt }], noQualifyingPools), [], "multiple pools cannot pool metrics across failed gates");
  const boundedPools = qualifyingDexScreenerQuotes([avnt], Array.from({ length: 6 }, (_, index) => ({
    chainId: "base", baseToken: { address: avnt }, quoteToken: { address: usdc }, pairAddress: `0x${(index + 80).toString(16).padStart(40, "0")}`,
    priceUsd: "0.13", liquidity: { usd: 10_000 - index }, volume: { h24: 2_000 }, txns: { h24: { buys: 10, sells: 10 } },
  })));
  assert.equal(boundedPools[avnt].poolCandidates?.length, MAX_DEXSCREENER_POOLS_PER_TOKEN);
  assert.deepEqual(boundedPools[avnt].poolCandidates?.map((pool) => pool.poolAddress), qualifyingDexScreenerQuotes([avnt], Array.from({ length: 6 }, (_, index) => ({
    chainId: "base", baseToken: { address: avnt }, quoteToken: { address: usdc }, pairAddress: `0x${(index + 80).toString(16).padStart(40, "0")}`,
    priceUsd: "0.13", liquidity: { usd: 10_000 - index }, volume: { h24: 2_000 }, txns: { h24: { buys: 10, sells: 10 } },
  })))[avnt].poolCandidates?.map((pool) => pool.poolAddress), "pool order and cap are deterministic");
  assert.deepEqual(potentialMarketEvidenceAddresses([{ address: avnt }], qualifyingDexScreenerQuotes([avnt], [
    { chainId: "base", baseToken: { address: avnt }, priceUsd: "0.1344", liquidity: { usd: 767042.32 } },
  ])), [], "a price and deep pool without transaction activity cannot request trusted market evidence");

  // D. The bounded market-evidence shortlist includes qualifying addresses
  // ranked 3, 12, and 16, while keeping all later candidates outside the cap.
  assert.equal(MARKET_EVIDENCE_LIMIT, 25);
  const zora = "0x1111111111166b7fe7bd91427724b487980afc69";
  const up = "0x5b2193fdc451c1f847be09ca9d13a4bf60f8c86b";
  const rankedAddresses = Array.from({ length: 30 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`);
  rankedAddresses[2] = zora;
  rankedAddresses[11] = up;
  rankedAddresses[15] = avnt;
  const rankedTokens = rankedAddresses.map((address) => ({ address }));
  const marketQuotes = Object.fromEntries(rankedAddresses.map((address) => [address, {
    source: "dexscreener" as const,
    verified: false,
    priceUsd: 1,
    liquidityUsd: 10_000,
    volume24hUsd: 20_000,
    buys24h: 20,
    sells24h: 20,
    poolAddress: other,
    quoteTokenAddress: usdc,
  }]));
  const selectedMarketCandidates = potentialMarketEvidenceAddresses(
    rankedTokens,
    marketQuotes,
    MARKET_EVIDENCE_LIMIT,
  );
  assert.equal(selectedMarketCandidates.length, 25);
  assert.ok(selectedMarketCandidates.includes(zora));
  assert.ok(selectedMarketCandidates.includes(up));
  assert.ok(selectedMarketCandidates.includes(avnt));
  assert.ok(!selectedMarketCandidates.includes(rankedAddresses[25]), "the 26th qualifying candidate remains outside the cap");

  const canonicalFirst = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const noPoolSecond = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const eligibleAfterExclusions = Array.from({ length: 26 }, (_, index) => `0x${(index + 501).toString(16).padStart(40, "0")}`);
  const preconditionAddresses = [canonicalFirst, noPoolSecond, ...eligibleAfterExclusions];
  const preconditionTokens = preconditionAddresses.map((address) => ({ address }));
  const preconditionQuotes = Object.fromEntries(preconditionAddresses.map((address) => [address, {
    ...marketQuotes[avnt], poolAddress: other, quoteTokenAddress: usdc,
  }]));
  preconditionQuotes[noPoolSecond].poolAddress = undefined;
  const shortlist = potentialMarketEvidenceAddresses(
    preconditionTokens,
    preconditionQuotes,
    MARKET_EVIDENCE_LIMIT,
    new Set([canonicalFirst.toUpperCase()]),
  );
  assert.equal(shortlist.length, MARKET_EVIDENCE_LIMIT);
  assert.deepEqual(shortlist, potentialMarketEvidenceAddresses(
    preconditionTokens,
    preconditionQuotes,
    MARKET_EVIDENCE_LIMIT,
    new Set([canonicalFirst]),
  ), "shortlist order is deterministic");
  assert.ok(shortlist.includes(eligibleAfterExclusions[24]), "canonical and missing-pool exclusions do not consume capacity");
  assert.ok(!shortlist.includes(eligibleAfterExclusions[25]), "the cap still bounds selected provider requests");

  const liquidityFailure = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const volumeFailure = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const tradeFailure = "0xcccccccccccccccccccccccccccccccccccccccc";
  const failedGateCandidates = [liquidityFailure, volumeFailure, tradeFailure];
  const failedGateQuotes = {
    ...marketQuotes,
    [liquidityFailure]: { ...marketQuotes[avnt], liquidityUsd: 999.99 },
    [volumeFailure]: { ...marketQuotes[avnt], volume24hUsd: 999.99 },
    [tradeFailure]: { ...marketQuotes[avnt], buys24h: 0 },
  };
  assert.deepEqual(
    potentialMarketEvidenceAddresses(
      [...rankedTokens, ...failedGateCandidates.map((address) => ({ address }))],
      failedGateQuotes,
      Number.MAX_SAFE_INTEGER,
    ).filter((address) => failedGateCandidates.includes(address)),
    [],
    "liquidity, volume, and positive-trade gates remain enforced before the limit",
  );

  const requestedUrls: string[] = [];
  await fetchDexScreenerQuotes(many, async (url) => {
    requestedUrls.push(url);
    return { data: [] };
  });
  assert.equal(requestedUrls.length, 3);
  assert.ok(requestedUrls.every((url) => url.startsWith(`${DEXSCREENER_BASE_URL}/`)));
  assert.ok(requestedUrls.every((url) => url.slice(`${DEXSCREENER_BASE_URL}/`.length).split(",").length <= 30));
  assert.equal(requestedUrls.filter((url) => /coingecko/i.test(url)).length, 0, "automatic pricing makes zero CoinGecko requests");
  const failedUrls: string[] = [];
  await fetchDexScreenerQuotes(many, async (url) => {
    failedUrls.push(url);
    throw new Error("public endpoint unavailable");
  });
  assert.equal(failedUrls.length, 3, "a failed batch never cascades into individual requests");

  // Regression fixture: the local USDC quote is canonical; AERO's Blockscout
  // value remains indicative until it passes the full market evidence policy.
  const usdcValue = Number(220466n) / 10 ** 6 * quotes[usdc].priceUsd;
  const aeroValue = Number(262197975720893986n) / 10 ** 18 * quotes[aero.toLowerCase()].priceUsd;
  assert.ok(usdcValue > 0.21 && usdcValue < 0.23);
  assert.ok(aeroValue > 0.13 && aeroValue < 0.15);
  assert.ok(usdcValue < 3 && aeroValue < 3 && quotes[usdc].verified && !quotes[aero.toLowerCase()].verified,
    "Blockscout prices remain indicative until independent market evidence passes");
  console.log("token pricing tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
