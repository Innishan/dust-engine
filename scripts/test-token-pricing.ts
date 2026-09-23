import assert from "node:assert/strict";
import { blockscoutQuotesFromBalanceItems } from "../server/tokenDiscovery";
import {
  DEXSCREENER_BATCH_SIZE,
  DEXSCREENER_BASE_URL,
  createInitialQuotes,
  dexScreenerChunks,
  fetchDexScreenerQuotes,
  qualifyingDexScreenerQuotes,
  unresolvedEligibleAddresses,
} from "../src/tokenPricing";

const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const aero = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const other = "0x1111111111111111111111111111111111111111";
const quoteOnly = "0x2222222222222222222222222222222222222222";
const weth = "0x4200000000000000000000000000000000000006";

async function run() {
  // A. Quotes are extracted only from valid, positively priced ERC-20 balance rows.
  const extracted = blockscoutQuotesFromBalanceItems([
    { token: { type: "ERC-20", address_hash: aero, exchange_rate: "0.538953", reputation: "ok", volume_24h: "1234.5" } },
    { token: { type: "ERC-20", address_hash: other, reputation: "ok" } },
    { token: { type: "ERC-20", address_hash: quoteOnly, exchange_rate: 0 } },
    { token: { type: "ERC-20", address_hash: usdc, exchange_rate: Number.NaN } },
    { token: { type: "ERC-721", address_hash: weth, exchange_rate: 1 } },
  ]);
  assert.deepEqual(extracted[aero.toLowerCase()], { priceUsd: 0.538953, reputation: "ok", volume24h: 1234.5 });
  assert.equal(Object.keys(extracted).length, 1);

  // B. Source precedence is strict and unresolved tokens fail closed.
  const quotes = createInitialQuotes({ [usdc]: 1 }, {
    [usdc]: { priceUsd: 0.999747, reputation: "ok" },
    [aero]: { priceUsd: 0.538953, reputation: "ok" },
  });
  assert.equal(quotes[usdc].source, "local");
  assert.equal(quotes[aero.toLowerCase()].source, "blockscout");
  const eligible = unresolvedEligibleAddresses([
    { address: other, source: "alchemy,blockscout-balances" },
    { address: quoteOnly, source: "alchemy" },
    { address: weth, source: "blockscout-balances" },
  ], quotes, weth);
  assert.deepEqual(eligible, [other]);
  const untrusted = createInitialQuotes({}, { [quoteOnly]: { priceUsd: 1, reputation: "scam" } });
  assert.equal(untrusted[quoteOnly], undefined, "non-ok Blockscout reputation cannot create a verified quote");
  assert.deepEqual(
    unresolvedEligibleAddresses([{ address: quoteOnly, source: "blockscout-balances" }], untrusted, weth, { [quoteOnly]: { priceUsd: 1, reputation: "scam" } }),
    [],
    "non-ok Blockscout reputation cannot reach DexScreener",
  );
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
  assert.deepEqual(candidates[other], { priceUsd: 2.5, source: "dexscreener", verified: true });
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

  // D/E. The automatic path has no CoinGecko client at all: 1,239 balances
  // yield only bounded DexScreener requests, while Blockscout-priced rows skip it.
  const balances = Array.from({ length: 1239 }, (_, index) => `0x${(index + 5000).toString(16).padStart(40, "0")}`);
  const blockscoutPriced = createInitialQuotes({}, Object.fromEntries(balances.slice(0, 39).map((address) => [address, { priceUsd: 1 }])));
  const unresolvedBalances = unresolvedEligibleAddresses(balances.map((address) => ({ address, source: "blockscout-balances" })), blockscoutPriced, weth);
  assert.equal(unresolvedBalances.length, 1200);
  assert.equal(dexScreenerChunks(unresolvedBalances).length, 40);
  assert.ok(dexScreenerChunks(unresolvedBalances).every((chunk) => chunk.length <= 30));

  // Regression fixture: $0.22 USDC and $0.14 AERO remain verified dust below $3.
  const usdcValue = Number(220466n) / 10 ** 6 * quotes[usdc].priceUsd;
  const aeroValue = Number(262197975720893986n) / 10 ** 18 * quotes[aero.toLowerCase()].priceUsd;
  assert.ok(usdcValue > 0.21 && usdcValue < 0.23);
  assert.ok(aeroValue > 0.13 && aeroValue < 0.15);
  assert.ok(usdcValue < 3 && aeroValue < 3 && quotes[usdc].verified && quotes[aero.toLowerCase()].verified);
  console.log("token pricing tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
