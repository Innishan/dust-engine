import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRateGate, EvidenceCache, fetchGeckoMarketEvidence, fetchGeckoMarketEvidenceDetailed, fetchGoPlusRisk, GECKOTERMINAL_BASE_URL, GECKO_MIN_INTERVAL_MS, GOPLUS_MIN_INTERVAL_MS, MARKET_EVIDENCE_CACHE_MS, MARKET_EVIDENCE_LIMIT, MAX_MARKET_POOL_REQUESTS, marketEvidencePoolKey, summarizeGoPlusDiagnostics } from "../src/marketEvidence";
import { createProviderRequestMetrics, measureProviderRequest } from "../src/scanDiagnostics";
import { evaluateMarketEvidence } from "../src/marketEvidence";

const token = "0x1111111111111111111111111111111111111111";
const quote = "0x2222222222222222222222222222222222222222";
const pool = "0x3333333333333333333333333333333333333333";
const now = 1_800_000_000_000;
const row = { id: `base_${pool}`, attributes: { base_token_price_usd: "2", reserve_in_usd: "5000", volume_usd: { h24: "1200" }, transactions: { h24: { buys: 9, sells: 8 } } }, relationships: { base_token: { data: { id: `base_${token}` } }, quote_token: { data: { id: `base_${quote}` } } } };
async function run() {
  const requestMetrics = createProviderRequestMetrics();
  let monotonic = 10;
  const fakeClock = () => monotonic;
  await measureProviderRequest(requestMetrics, async () => { monotonic += 3; return "success"; }, false, fakeClock);
  await assert.rejects(measureProviderRequest(requestMetrics, async () => { monotonic += 5; throw new Error("provider failure"); }, true, fakeClock));
  assert.deepEqual(requestMetrics, { requestCount: 2, retryRequestCount: 1, failedRequestCount: 1, requestDurationMs: 8 },
    "monotonic provider metrics count successful, failed, and retried attempts without changing request results");
  const eligibilityInput = {
    address: token,
    now,
    dex: { source: "dexscreener" as const, verified: false, priceUsd: 2, chainId: "8453", baseTokenAddress: token, poolAddress: pool, quoteTokenAddress: quote, liquidityUsd: 5_000, volume24hUsd: 2_000, buys24h: 9, sells24h: 8, fetchedAt: now },
    gecko: { chainId: "8453", tokenAddress: token, poolAddress: pool, baseTokenAddress: token, quoteTokenAddress: quote, priceUsd: 2.01, liquidityUsd: 5_000, volume24hUsd: 2_000, buys24h: 9, sells24h: 8, fetchedAt: now },
    pool: { chainId: 8453, token0: token, token1: quote, verified: true },
    risk: { status: "available" as const, fields: {}, fetchedAt: now },
  };
  const eligibilityBeforeMetrics = evaluateMarketEvidence(eligibilityInput);
  assert.equal(evaluateMarketEvidence({ ...eligibilityInput, risk: { status: "available", fields: { is_blacklisted: "1" }, fetchedAt: now } }).eligible, true,
    "GoPlus blacklist capability alone does not reject otherwise complete market evidence");
  assert.equal(evaluateMarketEvidence({ ...eligibilityInput, risk: { status: "available", fields: { is_blacklisted: "true" }, fetchedAt: now } }).eligible, true,
    "boolean-string blacklist capability alone does not reject otherwise complete market evidence");
  assert.equal(evaluateMarketEvidence({ ...eligibilityInput, risk: { status: "available", fields: { is_blacklisted: "0" }, fetchedAt: now } }).eligible, true,
    "explicit absence of blacklist capability continues to pass");
  for (const [field, adverseValue, rejects] of [
    ["is_open_source", false, true], ["is_honeypot", true, true], ["cannot_buy", true, true], ["cannot_sell", true, true],
    ["cannot_sell_all", true, true], ["trading_cooldown", true, true], ["is_whitelisted", true, true], ["is_anti_whale", true, true],
    ["transfer_pausable", true, true], ["slippage_modifiable", true, true], ["is_buyable", false, true], ["is_sellable", false, true],
  ] as Array<[string, boolean, boolean]>) {
    const numeric = adverseValue ? "1" : "0";
    const word = adverseValue ? "true" : "false";
    const numericResult = evaluateMarketEvidence({ ...eligibilityInput, risk: { status: "available", fields: { [field]: numeric }, fetchedAt: now } });
    const wordResult = evaluateMarketEvidence({ ...eligibilityInput, risk: { status: "available", fields: { [field]: word }, fetchedAt: now } });
    assert.equal(wordResult.reason, numericResult.reason, `${field} treats ${numeric} and ${word} equivalently`);
    assert.equal(numericResult.eligible, !rejects, `${field} preserves its explicit policy for adverse/benign values`);
  }
  assert.equal(evaluateMarketEvidence({ ...eligibilityInput, risk: { status: "available", fields: { is_blacklisted: "1", is_honeypot: "1" }, fetchedAt: now } }).reason, "adverse_goplus_finding",
    "independent adverse findings remain enforced alongside blacklist capability");
  await measureProviderRequest(requestMetrics, async () => "timed", false, fakeClock);
  assert.deepEqual(evaluateMarketEvidence(eligibilityInput), eligibilityBeforeMetrics,
    "adding timing and request counters leaves evidence eligibility unchanged");

  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const walletDiagnosticSource = readFileSync(new URL("../src/walletDiagnostics.ts", import.meta.url), "utf8");
  const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  for (const forbiddenLog of [
    'console.log("BACKEND RAW RESPONSE:"',
    'console.log("SCAN ADDRESS:"',
    'console.log("BATCH SIGNATURE:"',
    'console.log("MESSAGE:"',
    'console.log("FINAL BATCH:"',
    'console.log("TX DATA:"',
    'console.log("INPUT:"',
  ]) assert.equal(appSource.includes(forbiddenLog), false, `sensitive execution/discovery log removed: ${forbiddenLog}`);
  assert.match(walletDiagnosticSource, /walletDiagnosticsEnabled\s*=\s*import\.meta\.env\.DEV\s*&&/,
    "wallet diagnostics cannot be enabled in production builds");
  assert.equal(appSource.includes("console.error(err)"), false, "manual-token provider errors are sanitized before logging");
  for (const sensitiveServerLog of [
    'console.log("🧪 LI.FI PARAMS:"',
    'console.log("❌ NO ROUTE FROM LI.FI:"',
    "console.error('Response data:'",
    "console.log(`Proxying ENS request for address:",
  ]) assert.equal(serverSource.includes(sensitiveServerLog), false, `server does not log request or upstream data: ${sensitiveServerLog}`);
  assert.equal(serverSource.includes("full: response.data"), false, "LI.FI no-route responses do not echo full provider payloads");
  assert.ok(appSource.includes('console.log("TOKEN COUNT:"'), "aggregate discovery count remains available");
  const cache = new EvidenceCache();
  let requests = 0;
  const request = async (url: string) => { requests++; assert.ok(url.startsWith(`${GECKOTERMINAL_BASE_URL}/networks/base/pools/multi/`)); return { status: 200, data: { data: [row] } }; };
  const first = await fetchGeckoMarketEvidence([{ tokenAddress: token, poolAddress: pool }], request, cache, async () => undefined, now);
  assert.equal(first[token]?.poolAddress, pool);
  await fetchGeckoMarketEvidence([{ tokenAddress: token, poolAddress: pool }], request, cache, async () => undefined, now + 1);
  assert.equal(requests, 1, "same Base token/pool uses cache");
  await fetchGeckoMarketEvidence([{ tokenAddress: quote, poolAddress: pool }], request, cache, async () => undefined, now + 1);
  assert.equal(requests, 2, "cache key includes token identity");
  assert.equal(cache.get(`x`, now), undefined);
  const expires = new EvidenceCache(); expires.set("a", 1, now, MARKET_EVIDENCE_CACHE_MS);
  assert.equal(expires.get("a", now + MARKET_EVIDENCE_CACHE_MS), undefined, "cache expires at its bounded TTL");
  const bad = await fetchGeckoMarketEvidence([{ tokenAddress: token, poolAddress: pool }], async () => ({ status: 403, data: {} }), new EvidenceCache(), async () => undefined, now);
  assert.deepEqual(bad, {}, "provider 403 is a partial missing-evidence result");
  const malformed = await fetchGeckoMarketEvidence([{ tokenAddress: token, poolAddress: pool }], async () => ({ status: 200, data: { data: [{ ...row, attributes: { ...row.attributes, reserve_in_usd: "-1" } }] } }), new EvidenceCache(), async () => undefined, now);
  assert.deepEqual(malformed, {}, "negative liquidity is rejected");
  const alternativePool = "0x4444444444444444444444444444444444444444";
  const multiPoolResult = await fetchGeckoMarketEvidenceDetailed([
    { tokenAddress: token, poolAddress: pool },
    { tokenAddress: token, poolAddress: alternativePool },
  ], async () => ({ status: 200, data: { data: [{ ...row, id: `base_${alternativePool}` }] } }), new EvidenceCache(), async () => undefined, now);
  assert.equal(multiPoolResult.quotes[marketEvidencePoolKey(token, alternativePool)]?.poolAddress, alternativePool,
    "alternative pools are parsed independently against exact requested identity");
  assert.equal(multiPoolResult.diagnostics[marketEvidencePoolKey(token, pool)]?.status, "missing_data");
  assert.equal(multiPoolResult.diagnostics[marketEvidencePoolKey(token, alternativePool)]?.status, "available");
  const wrongPoolIdentity = await fetchGeckoMarketEvidenceDetailed([{ tokenAddress: token, poolAddress: pool }], async () => ({
    status: 200,
    data: { data: [{ ...row, relationships: { ...row.relationships, base_token: { data: { id: `base_${quote}` } } } }] },
  }), new EvidenceCache(), async () => undefined, now);
  assert.equal(wrongPoolIdentity.diagnostics[marketEvidencePoolKey(token, pool)]?.status, "pool_identity_mismatch");
  assert.equal(wrongPoolIdentity.quotes[marketEvidencePoolKey(token, pool)], undefined, "mismatched identity never creates evidence");
  const providerFailure = await fetchGeckoMarketEvidenceDetailed([{ tokenAddress: token, poolAddress: pool }], async () => ({ status: 403, data: {} }), new EvidenceCache(), async () => undefined, now);
  assert.deepEqual(providerFailure.diagnostics[marketEvidencePoolKey(token, pool)], {
    status: "provider_failure", category: "non_2xx_http_status", httpStatus: 403, attempts: 1,
  });
  const malformedProviderResponse = await fetchGeckoMarketEvidenceDetailed([{ tokenAddress: token, poolAddress: pool }], async () => ({ status: 200, data: { data: {} } }), new EvidenceCache(), async () => undefined, now);
  assert.equal(malformedProviderResponse.diagnostics[marketEvidencePoolKey(token, pool)]?.status, "provider_failure");
  assert.equal(malformedProviderResponse.diagnostics[marketEvidencePoolKey(token, pool)]?.category, "malformed_response");
  let retryCount = 0;
  const retried = await fetchGeckoMarketEvidence([{ tokenAddress: token, poolAddress: pool }], async () => {
    retryCount++;
    if (retryCount === 1) throw new Error("transient transport failure");
    return { status: 200, data: { data: [row] } };
  }, new EvidenceCache(), async () => undefined, now);
  assert.equal(retryCount, 2, "provider transport retries are bounded to one retry");
  assert.ok(retried[token]);
  assert.equal(MARKET_EVIDENCE_LIMIT, 25);
  const boundedRequestUrls: string[] = [];
  await fetchGeckoMarketEvidence(
    Array.from({ length: 30 }, (_, index) => ({
      tokenAddress: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      poolAddress: `0x${(index + 101).toString(16).padStart(40, "0")}`,
    })),
    async (url) => { boundedRequestUrls.push(url); return { status: 200, data: { data: [] } }; },
    new EvidenceCache(),
    async () => undefined,
    now,
  );
  const requestedPoolIds = boundedRequestUrls.map((url) => url.split("/pools/multi/")[1]?.split("?")[0].split(",").length ?? 0);
  assert.deepEqual(requestedPoolIds, [25, 5], "the GeckoTerminal calls batch candidate pools in groups capped at 25");
  const boundedCalls: string[] = [];
  const boundedEntries = Array.from({ length: 30 }, (_, index) => Array.from({ length: 3 }, (_, poolIndex) => ({
    tokenAddress: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    poolAddress: `0x${(index * 3 + poolIndex + 501).toString(16).padStart(40, "0")}`,
  }))).flat();
  const cappedDetails = await fetchGeckoMarketEvidenceDetailed(boundedEntries, async (url) => {
    boundedCalls.push(url);
    return { status: 200, data: { data: [] } };
  }, new EvidenceCache(), async () => undefined, now);
  assert.equal(MAX_MARKET_POOL_REQUESTS, MARKET_EVIDENCE_LIMIT * 3);
  assert.equal(Object.keys(cappedDetails.diagnostics).length, MAX_MARKET_POOL_REQUESTS, "pool requests stay bounded at 25 tokens x 3 pools");
  assert.equal(boundedCalls.length, 3, "bounded alternatives are split into batches of no more than 25 pools");
  assert.ok(boundedCalls.every((url) => (url.split("/pools/multi/")[1]?.split("?")[0].split(",").length ?? 0) <= MARKET_EVIDENCE_LIMIT));
  let goPlusRequests = 0;
  const risk = await fetchGoPlusRisk(token, async () => { goPlusRequests++; return { status: 200, data: { code: 1, result: { [token]: { is_honeypot: "1", buy_tax: "0.01" } } } }; }, cache, async () => undefined, now);
  assert.equal(risk.fields.is_honeypot, "1");
  assert.deepEqual(risk.diagnostic, {
    category: "success", attempts: 1, httpStatus: 200,
    responseCodeType: "number", normalizedCodeCategory: "success", resultContainerPresent: true, tokenEntryPresent: true,
  });
  const riskDiagnosticAggregate = summarizeGoPlusDiagnostics([
    risk,
    { status: "unavailable", fields: {}, diagnostic: { category: "non_2xx_http_status", attempts: 2, httpStatus: 429, providerErrorCategory: "rate_limited" } },
    { status: "unavailable", fields: {}, diagnostic: { category: "partial_data", attempts: 2, httpStatus: 200, responseCodeType: "string", normalizedCodeCategory: "non_success" } },
    { status: "unavailable", fields: {}, diagnostic: { category: "timeout", attempts: 2 } },
    { status: "malformed", fields: {}, diagnostic: { category: "malformed_risk_fields", attempts: 1, httpStatus: 200, responseCodeType: "number", normalizedCodeCategory: "success" } },
    { status: "unavailable", fields: {}, diagnostic: { category: "missing_token_entry", attempts: 1, httpStatus: 200, responseCodeType: "number", normalizedCodeCategory: "success" } },
  ]);
  assert.equal(riskDiagnosticAggregate.total, 6);
  assert.deepEqual(riskDiagnosticAggregate.riskStatusCounts, { available: 1, malformed: 1, unavailable: 4 });
  assert.equal(riskDiagnosticAggregate.categoryCounts.partial_data, 1);
  assert.equal(riskDiagnosticAggregate.providerErrorCategoryCounts.rate_limited, 1);
  assert.equal(riskDiagnosticAggregate.attemptCountCounts["2"], 3);
  assert.equal(riskDiagnosticAggregate.httpStatusCounts["200"], 4);
  assert.equal(riskDiagnosticAggregate.responseCodeTypeCounts.number, 3);
  assert.equal(riskDiagnosticAggregate.normalizedStatusCategoryCounts.success, 3);
  assert.equal(riskDiagnosticAggregate.groupedOutcomes.length, 6);
  const sanitizedAggregate = summarizeGoPlusDiagnostics([{
    status: "unavailable", fields: {}, diagnostic: {
      category: "token-address-secret" as any, attempts: 999, httpStatus: 9000,
      providerErrorCategory: "https://credential-bearing-url" as any,
      responseCodeType: "private-key" as any,
      normalizedCodeCategory: "raw-provider-body" as any,
    },
  } as any]);
  assert.equal(sanitizedAggregate.categoryCounts.missing_or_unknown, 1);
  assert.equal(sanitizedAggregate.providerErrorCategoryCounts.none, 1);
  assert.equal(sanitizedAggregate.attemptCountCounts.unknown, 1);
  assert.equal(sanitizedAggregate.httpStatusCounts.missing_or_invalid, 1);
  assert.equal(sanitizedAggregate.responseCodeTypeCounts.missing, 1);
  assert.equal(JSON.stringify(sanitizedAggregate).includes("credential-bearing-url"), false, "unrecognized provider data never appears in summary");
  const stringCode = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: "1", result: { [token]: {} } } }), new EvidenceCache(), async () => undefined, now);
  assert.equal(stringCode.status, "available", "string form of success code remains accepted");
  assert.equal(stringCode.diagnostic?.responseCodeType, "string");
  const mixedCaseToken = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const riskForKey = (key: string) => fetchGoPlusRisk(
    mixedCaseToken,
    async () => ({ status: 200, data: { code: 1, result: { [key]: { is_blacklisted: "0" } } } }),
    new EvidenceCache(), async () => undefined, now,
  );
  for (const key of [
    mixedCaseToken,
    `0x${mixedCaseToken.slice(2).toUpperCase()}`,
    `0x${mixedCaseToken.slice(2).split("").map((char, index) => index % 2 ? char.toUpperCase() : char).join("")}`,
  ]) {
    const parsed = await riskForKey(key);
    assert.equal(parsed.status, "available", `token result key ${key} is matched without regard to hex letter case`);
    assert.equal(parsed.fields.is_blacklisted, "0");
  }
  const httpFailure = await fetchGoPlusRisk(token, async () => ({ status: 403, data: {} }), new EvidenceCache(), async () => undefined, now);
  assert.deepEqual(httpFailure.diagnostic, { category: "non_2xx_http_status", attempts: 1, httpStatus: 403 });
  let rateLimitedAttempts = 0;
  const rateLimited = await fetchGoPlusRisk(token, async () => { rateLimitedAttempts++; return { status: 429, data: {} }; }, new EvidenceCache(), async () => undefined, now);
  assert.equal(rateLimited.status, "unavailable");
  assert.deepEqual(rateLimited.diagnostic, { category: "non_2xx_http_status", attempts: 2, httpStatus: 429, providerErrorCategory: "rate_limited" });
  assert.equal(rateLimitedAttempts, 2, "rate-limited response is retried once, then surfaced as HTTP 429");
  for (const retryStatus of [429, 503]) {
    let retryStatusAttempts = 0;
    const retryStatusResult = await fetchGoPlusRisk(token, async () => {
      retryStatusAttempts++;
      return retryStatusAttempts === 1
        ? { status: retryStatus, data: {} }
        : { status: 200, data: { code: 1, result: { [token]: { is_blacklisted: "0" } } } };
    }, new EvidenceCache(), async () => undefined, now, async () => undefined);
    assert.equal(retryStatusResult.status, "available", `HTTP ${retryStatus} retains its existing single retry`);
    assert.equal(retryStatusResult.diagnostic?.attempts, 2);
    assert.equal(retryStatusAttempts, 2, `HTTP ${retryStatus} retry does not multiply requests`);
  }
  const badApiCode = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: 0, result: {} } }), new EvidenceCache(), async () => undefined, now);
  assert.deepEqual(badApiCode.diagnostic, {
    category: "unexpected_api_code", attempts: 1, httpStatus: 200,
    responseCodeType: "number", normalizedCodeCategory: "non_success", resultContainerPresent: true,
    tokenEntryPresent: false, providerErrorCategory: "provider_error",
  });
  let applicationRateLimitAttempts = 0;
  const applicationRateLimitWaits: number[] = [];
  const applicationRateLimitCooldowns: number[] = [];
  const applicationRateLimitGate = Object.assign(async () => undefined, {
    extendCooldown: (ms: number) => { applicationRateLimitCooldowns.push(ms); },
  });
  const rateLimitedApiCode = await fetchGoPlusRisk(token, async () => {
    applicationRateLimitAttempts++;
    return applicationRateLimitAttempts === 1
      ? { status: 200, data: { code: 429, message: "rate limit exceeded" } }
      : { status: 200, data: { code: 1, result: { [token]: { is_blacklisted: "0" } } } };
  }, new EvidenceCache(), applicationRateLimitGate, now, async (ms) => { applicationRateLimitWaits.push(ms); });
  assert.equal(rateLimitedApiCode.status, "available", "HTTP 200 application rate limit retries and accepts a later successful response");
  assert.equal(rateLimitedApiCode.diagnostic?.attempts, 2);
  assert.equal(applicationRateLimitAttempts, 2);
  assert.deepEqual(applicationRateLimitWaits, [2_000], "application rate limit uses bounded backoff");
  assert.deepEqual(applicationRateLimitCooldowns, [10_000], "application rate limit extends the shared request queue cooldown");

  for (const limitCode of [4029, "4029"] as const) {
    let attempts = 0;
    const waits: number[] = [];
    const limitedThenSuccess = await fetchGoPlusRisk(token, async () => {
      attempts++;
      return attempts === 1
        ? { status: 200, data: { code: limitCode, result: {} } }
        : { status: 200, data: { code: 1, result: { [token]: { is_blacklisted: "0" } } } };
    }, new EvidenceCache(), async () => undefined, now, async (ms) => { waits.push(ms); });
    assert.equal(limitedThenSuccess.status, "available", `numeric/string ${limitCode} retries into success`);
    assert.equal(limitedThenSuccess.diagnostic?.attempts, 2);
    assert.equal(attempts, 2, "request-limit retry is capped at one retry");
    assert.deepEqual(waits, [2_000], "request-limit retry uses a short bounded backoff");
  }

  let persistent4029Attempts = 0;
  const persistent4029 = await fetchGoPlusRisk(token, async () => {
    persistent4029Attempts++;
    return { status: 200, data: { code: "4029" } };
  }, new EvidenceCache(), async () => undefined, now, async () => undefined);
  assert.equal(persistent4029.status, "unavailable", "persistent code 4029 remains fail-closed");
  assert.equal(persistent4029.diagnostic?.providerErrorCategory, "rate_limited");
  assert.equal(persistent4029.diagnostic?.category, "application_rate_limit");
  assert.equal(persistent4029.diagnostic?.responseCodeCategory, "request_limit_4029");
  assert.equal(persistent4029.diagnostic?.attempts, 2);
  assert.equal(persistent4029Attempts, 2);

  let partialAttempts = 0;
  const partialWaits: number[] = [];
  const partialThenSuccess = await fetchGoPlusRisk(token, async () => {
    partialAttempts++;
    return partialAttempts === 1
      ? { status: 200, data: { code: "2", result: { [token]: {} } } }
      : { status: 200, data: { code: 1, result: { [token]: { is_blacklisted: "0" } } } };
  }, new EvidenceCache(), async () => undefined, now, async (ms) => { partialWaits.push(ms); });
  assert.equal(partialThenSuccess.status, "available", "partial data is retried and later success is accepted");
  assert.equal(partialThenSuccess.diagnostic?.attempts, 2);
  assert.deepEqual(partialWaits, [15_000], "partial-data retry honors documented approximate 15-second wait");

  let persistentPartialAttempts = 0;
  const persistentPartial = await fetchGoPlusRisk(token, async () => {
    persistentPartialAttempts++;
    return { status: 200, data: { code: 2, result: { [token]: {} } } };
  }, new EvidenceCache(), async () => undefined, now, async () => undefined);
  assert.equal(persistentPartial.status, "unavailable", "persistent partial data does not become risk evidence");
  assert.equal(persistentPartial.diagnostic?.category, "partial_data");
  assert.equal(persistentPartial.diagnostic?.attempts, 2);
  assert.equal(persistentPartialAttempts, 2, "partial-data retries are bounded");

  for (const malformedCode of [[1], { value: 1 }] as unknown[]) {
    let malformedAttempts = 0;
    const malformedCodeResult = await fetchGoPlusRisk(token, async () => {
      malformedAttempts++;
      return { status: 200, data: { code: malformedCode, result: { [token]: {} } } };
    }, new EvidenceCache(), async () => undefined, now);
    assert.equal(malformedCodeResult.status, "unavailable", "non-scalar response codes fail closed");
    assert.equal(malformedCodeResult.diagnostic?.category, "unexpected_response_shape");
    assert.equal(malformedCodeResult.diagnostic?.attempts, 1, "malformed response codes are not retried");
    assert.equal(malformedAttempts, 1);
  }

  const unknownCode = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: 77, result: { [token]: {} } } }), new EvidenceCache(), async () => undefined, now);
  assert.equal(unknownCode.status, "unavailable", "unknown scalar codes remain fail-closed");
  assert.equal(unknownCode.diagnostic?.category, "unexpected_api_code");
  assert.equal(unknownCode.diagnostic?.attempts, 1);

  let persistentApplicationRateLimitAttempts = 0;
  const persistentApplicationRateLimit = await fetchGoPlusRisk(token, async () => {
    persistentApplicationRateLimitAttempts++;
    return { status: 200, data: { code: 429, message: "rate limit exceeded" } };
  }, new EvidenceCache(), async () => undefined, now, async () => undefined);
  assert.equal(persistentApplicationRateLimit.status, "unavailable", "persistent application rate limit remains fail-closed");
  assert.deepEqual(persistentApplicationRateLimit.diagnostic, {
    category: "application_rate_limit", attempts: 2, httpStatus: 200,
    responseCodeType: "number", normalizedCodeCategory: "non_success", resultContainerPresent: false,
    tokenEntryPresent: false, providerErrorCategory: "rate_limited", responseCodeCategory: "rate_limited_other_code",
  });
  assert.equal(persistentApplicationRateLimitAttempts, 2, "application rate-limit retries are capped at one retry");

  const ordinarySuccess = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: 1, result: { [token]: { is_blacklisted: "0" } } } }), new EvidenceCache(), async () => undefined, now, async () => undefined);
  assert.equal(ordinarySuccess.status, "available");
  assert.equal(ordinarySuccess.diagnostic?.attempts, 1, "ordinary success does not incur an extra request");
  assert.equal(rateLimitedApiCode.fields.is_blacklisted, "0", "the retried successful response is parsed as risk evidence");
  const missingApiCode = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { result: {} } }), new EvidenceCache(), async () => undefined, now);
  assert.deepEqual(missingApiCode.diagnostic, {
    category: "unexpected_response_shape", attempts: 1, httpStatus: 200,
    responseCodeType: "missing", normalizedCodeCategory: "missing", resultContainerPresent: true,
    tokenEntryPresent: false,
  });
  const badShape = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: 1, result: [] } }), new EvidenceCache(), async () => undefined, now);
  assert.deepEqual(badShape.diagnostic, {
    category: "unexpected_response_shape", attempts: 1, httpStatus: 200,
    responseCodeType: "number", normalizedCodeCategory: "success", resultContainerPresent: false, tokenEntryPresent: false,
  });
  const missingEntry = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: 1, result: { [quote]: {} } } }), new EvidenceCache(), async () => undefined, now);
  assert.deepEqual(missingEntry.diagnostic, {
    category: "missing_token_entry", attempts: 1, httpStatus: 200,
    responseCodeType: "number", normalizedCodeCategory: "success", resultContainerPresent: true, tokenEntryPresent: false,
  });
  const malformedRisk = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: 1, result: { [token]: { is_blacklisted: true } } } }), new EvidenceCache(), async () => undefined, now);
  assert.equal(malformedRisk.status, "malformed");
  assert.deepEqual(malformedRisk.diagnostic, {
    category: "malformed_risk_fields", attempts: 1, httpStatus: 200,
    responseCodeType: "number", normalizedCodeCategory: "success", resultContainerPresent: true, tokenEntryPresent: true,
  });
  const timedOut = await fetchGoPlusRisk(token, async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); }, new EvidenceCache(), async () => undefined, now);
  assert.deepEqual(timedOut.diagnostic, { category: "timeout", attempts: 2 });
  const transportFailure = await fetchGoPlusRisk(token, async () => { throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" }); }, new EvidenceCache(), async () => undefined, now);
  assert.deepEqual(transportFailure.diagnostic, { category: "transport_or_request_exception", attempts: 2 });
  for (const [field, value] of [
    ["is_honeypot", true], ["is_honeypot", { value: "1" }], ["is_honeypot", ["1"]],
    ["buy_tax", true], ["buy_tax", { value: "0.01" }], ["buy_tax", ["0.01"]],
  ] as Array<[string, unknown]>) {
    const parsed = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: 1, result: { [token]: { [field]: value } } } }), new EvidenceCache(), async () => undefined, now);
    assert.equal(parsed.status, "malformed", `${field} with unsupported ${Array.isArray(value) ? "array" : typeof value} type fails closed`);
  }
  const validForms = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: 1, result: { [token]: { is_honeypot: "false", buy_tax: 0.1 } } } }), new EvidenceCache(), async () => undefined, now);
  assert.equal(validForms.status, "available", "binary strings and finite numeric tax values remain supported");
  assert.equal(validForms.fields.buy_tax, "0.1");
  for (const value of ["0", "1", "false", "true"]) {
    const parsed = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: 1, result: { [token]: { is_honeypot: value } } } }), new EvidenceCache(), async () => undefined, now);
    assert.equal(parsed.status, "available", `recognized boolean representation ${value} parses`);
  }
  const unknownField = await fetchGoPlusRisk(token, async () => ({ status: 200, data: { code: 1, result: { [token]: { provider_extension: { detail: true }, is_honeypot: "0" } } } }), new EvidenceCache(), async () => undefined, now);
  assert.equal(unknownField.status, "available", "unsupported unrecognized fields remain ignored");
  await fetchGoPlusRisk(token, async () => { goPlusRequests++; return {}; }, cache, async () => undefined, now + 1);
  assert.equal(goPlusRequests, 1, "GoPlus result is cached by Base token address");
  assert.equal((await fetchGoPlusRisk(quote, async () => { throw new Error("network"); }, cache, async () => undefined, now)).status, "unavailable");
  const waits: number[] = [];
  let clock = 100;
  const gate = createRateGate(1000, async (ms) => { waits.push(ms); clock += ms; }, () => clock);
  await gate(); await gate(); await gate();
  assert.deepEqual(waits, [1000, 1000], "request gate enforces configured interval with serialized callers");
  const cooldownWaits: number[] = [];
  let cooldownClock = 0;
  const cooldownGate = createRateGate(2_000, async (ms) => { cooldownWaits.push(ms); cooldownClock += ms; }, () => cooldownClock);
  await cooldownGate();
  cooldownGate.extendCooldown?.(10_000);
  await cooldownGate();
  assert.deepEqual(cooldownWaits, [10_000], "shared request gate honors a provider cooldown without a concurrent retry burst");
  const queuedCooldownWaits: number[] = [];
  const queuedReleases: Array<() => void> = [];
  let queuedClock = 0;
  const queuedCooldownGate = createRateGate(2_000, (ms) => new Promise<void>((resolve) => {
    queuedCooldownWaits.push(ms);
    queuedReleases.push(() => { queuedClock += ms; resolve(); });
  }), () => queuedClock);
  await queuedCooldownGate();
  const alreadyQueuedSlot = queuedCooldownGate();
  await Promise.resolve();
  queuedCooldownGate.extendCooldown?.(10_000);
  queuedReleases.shift()?.();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(queuedCooldownWaits, [2_000, 8_000], "a cooldown extension also pauses requests already waiting in the shared queue");
  queuedReleases.shift()?.();
  await alreadyQueuedSlot;
  assert.equal(GECKO_MIN_INTERVAL_MS, 6000, "GeckoTerminal gate is no more than ten requests/minute");
  assert.equal(GOPLUS_MIN_INTERVAL_MS, 2000, "GoPlus gate is no more than thirty requests/minute");
  console.log("market evidence provider tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
