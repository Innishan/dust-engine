import { normalizeTokenAddress, validPrice, MIN_DEX_TRADES_24H, MIN_DEX_VOLUME_24H_USD, MIN_TRUSTED_LIQUIDITY_USD, MAX_DEXSCREENER_POOLS_PER_TOKEN, type PriceQuote } from "./tokenPricing";

export const BASE_CHAIN_ID = "8453";
export const GECKOTERMINAL_BASE_URL = "https://api.geckoterminal.com/api/v2";
export const GOPLUS_BASE_URL = "https://api.gopluslabs.io/api/v1/token_security/8453";
export const MARKET_EVIDENCE_LIMIT = 25;
export const MAX_MARKET_POOL_REQUESTS = MARKET_EVIDENCE_LIMIT * MAX_DEXSCREENER_POOLS_PER_TOKEN;
export const MARKET_EVIDENCE_CACHE_MS = 60_000;
export const GECKO_MIN_INTERVAL_MS = 6_000;
export const GOPLUS_MIN_INTERVAL_MS = 2_000;
export const MAX_MARKET_PRICE_USD = 1_000_000;
export const MAX_MARKET_METRIC_USD = 1_000_000_000_000;
export const MAX_SOURCE_AGE_MS = 5 * 60_000;
export const MARKET_EVIDENCE_MAX_CACHE_ENTRIES = 500;
export const MAX_CORROBORATING_PRICE_RATIO = 1.25;

export type GeckoMarketQuote = {
  chainId: string;
  tokenAddress: string;
  poolAddress: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  buys24h: number;
  sells24h: number;
  fetchedAt: number;
};
export type GeckoPoolDiagnostic = {
  status: "available" | "cached" | "provider_failure" | "missing_data" | "malformed_data" | "pool_identity_mismatch";
  category?: "timeout" | "transport_or_request_exception" | "non_2xx_http_status" | "malformed_response";
  httpStatus?: number;
  attempts?: number;
};
export function marketEvidencePoolKey(tokenAddress: string, poolAddress: string): string {
  return `${normalizeTokenAddress(tokenAddress) ?? "invalid"}:${normalizeTokenAddress(poolAddress) ?? "invalid"}`;
}
export type GoPlusDiagnosticCategory =
  | "timeout"
  | "transport_or_request_exception"
  | "non_2xx_http_status"
  | "application_rate_limit"
  | "unexpected_api_code"
  | "partial_data"
  | "unexpected_response_shape"
  | "missing_token_entry"
  | "malformed_risk_fields"
  | "success"
  | "invalid_token_address";
export type GoPlusRiskDiagnostic = {
  category: GoPlusDiagnosticCategory;
  attempts: number;
  httpStatus?: number;
  responseCodeType?: "number" | "string" | "boolean" | "object" | "array" | "null" | "undefined" | "missing";
  normalizedCodeCategory?: "success" | "non_success" | "missing";
  responseCodeCategory?: "success_1" | "partial_2" | "request_limit_4029" | "rate_limited_other_code" | "other_scalar" | "missing" | "malformed";
  resultContainerPresent?: boolean;
  tokenEntryPresent?: boolean;
  providerErrorCategory?: "rate_limited" | "authentication_or_authorization" | "unsupported_token_or_chain" | "invalid_request" | "provider_error";
};
export type GoPlusRisk = {
  status: "available" | "unavailable" | "malformed";
  fields: Record<string, string>;
  fetchedAt?: number;
  diagnostic?: GoPlusRiskDiagnostic;
};
export type GoPlusDiagnosticAggregate = {
  total: number;
  riskStatusCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  providerErrorCategoryCounts: Record<string, number>;
  attemptCountCounts: Record<string, number>;
  httpStatusCounts: Record<string, number>;
  responseCodeTypeCounts: Record<string, number>;
  normalizedStatusCategoryCounts: Record<string, number>;
  groupedOutcomes: Array<{
    category: string;
    providerErrorCategory: string;
    attempts: string;
    httpStatus: string;
    responseCodeType: string;
    normalizedCodeCategory: string;
    count: number;
  }>;
};
export type PoolIdentity = { chainId: number; token0: string; token1: string; verified: boolean };
export type MarketEvidenceInput = {
  address: unknown;
  dex?: PriceQuote;
  gecko?: GeckoMarketQuote;
  pool?: PoolIdentity;
  risk?: GoPlusRisk;
  now?: number;
};
export type MarketEligibility = { eligible: boolean; reason: string; riskStatus?: "unknown" | "no_explicit_adverse_flag" };

const GOPLUS_DIAGNOSTIC_CATEGORIES = new Set<GoPlusDiagnosticCategory>([
  "timeout", "transport_or_request_exception", "non_2xx_http_status", "application_rate_limit", "unexpected_api_code",
  "partial_data", "unexpected_response_shape", "missing_token_entry", "malformed_risk_fields",
  "success", "invalid_token_address",
]);
const GOPLUS_PROVIDER_ERROR_CATEGORIES = new Set<NonNullable<GoPlusRiskDiagnostic["providerErrorCategory"]>>([
  "rate_limited", "authentication_or_authorization", "unsupported_token_or_chain", "invalid_request", "provider_error",
]);
const GOPLUS_RESPONSE_CODE_TYPES = new Set<NonNullable<GoPlusRiskDiagnostic["responseCodeType"]>>([
  "number", "string", "boolean", "object", "array", "null", "undefined", "missing",
]);

/** Aggregate only bounded diagnostic labels and counts; never includes token identities or provider messages. */
export function summarizeGoPlusDiagnostics(risks: Iterable<GoPlusRisk>): GoPlusDiagnosticAggregate {
  const riskStatusCounts: Record<string, number> = { available: 0, unavailable: 0, malformed: 0 };
  const categoryCounts: Record<string, number> = {};
  const providerErrorCategoryCounts: Record<string, number> = {};
  const attemptCountCounts: Record<string, number> = {};
  const httpStatusCounts: Record<string, number> = {};
  const responseCodeTypeCounts: Record<string, number> = {};
  const normalizedStatusCategoryCounts: Record<string, number> = {};
  const grouped = new Map<string, GoPlusDiagnosticAggregate["groupedOutcomes"][number]>();
  let total = 0;
  for (const risk of risks) {
    total += 1;
    const riskStatus = risk.status === "available" || risk.status === "unavailable" || risk.status === "malformed" ? risk.status : "unknown";
    riskStatusCounts[riskStatus] = (riskStatusCounts[riskStatus] ?? 0) + 1;
    const diagnostic = risk.diagnostic;
    const category = diagnostic && GOPLUS_DIAGNOSTIC_CATEGORIES.has(diagnostic.category) ? diagnostic.category : "missing_or_unknown";
    const providerErrorCategory = diagnostic?.providerErrorCategory && GOPLUS_PROVIDER_ERROR_CATEGORIES.has(diagnostic.providerErrorCategory)
      ? diagnostic.providerErrorCategory : "none";
    const attempts = Number.isInteger(diagnostic?.attempts) && diagnostic!.attempts >= 0 && diagnostic!.attempts <= 2
      ? String(diagnostic!.attempts) : "unknown";
    const httpStatus = Number.isInteger(diagnostic?.httpStatus) && diagnostic!.httpStatus >= 100 && diagnostic!.httpStatus <= 599
      ? String(diagnostic!.httpStatus) : "missing_or_invalid";
    const responseCodeType = diagnostic?.responseCodeType && GOPLUS_RESPONSE_CODE_TYPES.has(diagnostic.responseCodeType)
      ? diagnostic.responseCodeType : "missing";
    const normalizedCodeCategory = diagnostic?.normalizedCodeCategory === "success" || diagnostic?.normalizedCodeCategory === "non_success"
      || diagnostic?.normalizedCodeCategory === "missing" ? diagnostic.normalizedCodeCategory : "unknown";
    for (const [counts, value] of [
      [categoryCounts, category],
      [providerErrorCategoryCounts, providerErrorCategory],
      [attemptCountCounts, attempts],
      [httpStatusCounts, httpStatus],
      [responseCodeTypeCounts, responseCodeType],
      [normalizedStatusCategoryCounts, normalizedCodeCategory],
    ] as Array<[Record<string, number>, string]>) counts[value] = (counts[value] ?? 0) + 1;
    const groupKey = JSON.stringify([category, providerErrorCategory, attempts, httpStatus, responseCodeType, normalizedCodeCategory]);
    const group = grouped.get(groupKey);
    if (group) group.count += 1;
    else grouped.set(groupKey, { category, providerErrorCategory, attempts, httpStatus, responseCodeType, normalizedCodeCategory, count: 1 });
  }
  const sortCounts = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  return {
    total,
    riskStatusCounts,
    categoryCounts: sortCounts(categoryCounts),
    providerErrorCategoryCounts: sortCounts(providerErrorCategoryCounts),
    attemptCountCounts: sortCounts(attemptCountCounts),
    httpStatusCounts: sortCounts(httpStatusCounts),
    responseCodeTypeCounts: sortCounts(responseCodeTypeCounts),
    normalizedStatusCategoryCounts: sortCounts(normalizedStatusCategoryCounts),
    groupedOutcomes: [...grouped.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

function positiveMetric(value: unknown, ceiling: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= ceiling;
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function pricesAgree(a: number, b: number): boolean { return Math.max(a, b) / Math.min(a, b) <= MAX_CORROBORATING_PRICE_RATIO; }
function booleanFlag(fields: Record<string, string>, key: string): boolean | undefined {
  const value = fields[key]?.toLowerCase();
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}
function riskAdverse(fields: Record<string, string>): boolean {
  const yes = (key: string) => booleanFlag(fields, key) === true;
  if (booleanFlag(fields, "is_open_source") === false) return true;
  if (["is_honeypot", "cannot_buy", "cannot_sell", "cannot_sell_all", "trading_cooldown", "is_whitelisted", "is_anti_whale", "transfer_pausable", "slippage_modifiable"].some(yes)) return true;
  if (booleanFlag(fields, "is_buyable") === false || booleanFlag(fields, "is_sellable") === false) return true;
  const buyTax = Number(fields.buy_tax);
  const sellTax = Number(fields.sell_tax);
  return (Number.isFinite(buyTax) && buyTax > 0.1) || (Number.isFinite(sellTax) && sellTax > 0.1);
}
function hasKnownRiskSignal(fields: Record<string, string>): boolean {
  const binaryKeys = ["is_open_source", "is_honeypot", "cannot_buy", "cannot_sell", "cannot_sell_all", "trading_cooldown", "is_blacklisted", "is_whitelisted", "is_anti_whale", "transfer_pausable", "slippage_modifiable", "is_buyable", "is_sellable"];
  if (binaryKeys.some((key) => booleanFlag(fields, key) !== undefined)) return true;
  return ["buy_tax", "sell_tax"].some((key) => {
    const value = Number(fields[key]);
    return fields[key] !== undefined && fields[key] !== "" && Number.isFinite(value) && value >= 0 && value <= 1;
  });
}
function malformedRisk(fields: Record<string, string>): boolean {
  const binaryKeys = ["is_open_source", "is_honeypot", "cannot_buy", "cannot_sell", "cannot_sell_all", "trading_cooldown", "is_blacklisted", "is_whitelisted", "is_anti_whale", "transfer_pausable", "slippage_modifiable", "is_buyable", "is_sellable"];
  if (binaryKeys.some((key) => fields[key] !== undefined && fields[key] !== "" && !["0", "1", "true", "false"].includes(fields[key].toLowerCase()))) return true;
  return ["buy_tax", "sell_tax"].some((key) => {
    if (fields[key] === undefined || fields[key] === "") return false;
    const value = Number(fields[key]);
    return !Number.isFinite(value) || value < 0 || value > 1;
  });
}

// Eligibility is an evidence gate, not a safety score. Missing GoPlus fields
// remain unknown; they do not block otherwise-complete corroboration and never
// produce a claim that a token is safe. Explicit adverse findings do block.
export function evaluateMarketEvidence(input: MarketEvidenceInput): MarketEligibility {
  const token = normalizeTokenAddress(input.address);
  if (!token) return { eligible: false, reason: "invalid_token_address" };
  const dex = input.dex;
  const gecko = input.gecko;
  const pool = input.pool;
  const risk = input.risk;
  if (!dex) return { eligible: false, reason: "missing_dexscreener_evidence" };
  if (!gecko) return { eligible: false, reason: "missing_geckoterminal_evidence" };
  if (!pool) return { eligible: false, reason: "base_rpc_pool_verification_unavailable" };
  if (risk?.status === "malformed") return { eligible: false, reason: "malformed_goplus_risk_data" };
  if (!risk || risk.status !== "available" || !Number.isFinite(risk.fetchedAt)) return { eligible: false, reason: "goplus_risk_evidence_unavailable" };
  if (malformedRisk(risk.fields)) return { eligible: false, reason: "malformed_goplus_risk_data" };
  if (riskAdverse(risk.fields)) return { eligible: false, reason: "adverse_goplus_finding", riskStatus: "unknown" };
  const dexPool = normalizeTokenAddress(dex.poolAddress);
  const geckoPool = normalizeTokenAddress(gecko.poolAddress);
  const geckoToken = normalizeTokenAddress(gecko.tokenAddress);
  const geckoBase = normalizeTokenAddress(gecko.baseTokenAddress);
  const dexBase = normalizeTokenAddress(dex.baseTokenAddress);
  const geckoQuote = normalizeTokenAddress(gecko.quoteTokenAddress);
  const dexQuote = normalizeTokenAddress(dex.quoteTokenAddress);
  if (dex.chainId !== BASE_CHAIN_ID || gecko.chainId !== BASE_CHAIN_ID || pool.chainId !== 8453) return { eligible: false, reason: "wrong_chain" };
  if (!dexPool || !geckoPool || dexPool !== geckoPool || !dexBase || dexBase !== token || geckoToken !== token || geckoBase !== token || !dexQuote || dexQuote !== geckoQuote) return { eligible: false, reason: "pool_or_token_mismatch" };
  const token0 = normalizeTokenAddress(pool.token0);
  const token1 = normalizeTokenAddress(pool.token1);
  if (!pool.verified || !token0 || !token1 || !((token0 === token && token1 === dexQuote) || (token1 === token && token0 === dexQuote))) return { eligible: false, reason: "rpc_pool_pair_mismatch" };
  const now = input.now ?? Date.now();
  if (!Number.isFinite(dex.fetchedAt) || now - (dex.fetchedAt as number) < 0 || now - (dex.fetchedAt as number) > MAX_SOURCE_AGE_MS
    || !Number.isFinite(gecko.fetchedAt) || now - gecko.fetchedAt < 0 || now - gecko.fetchedAt > MAX_SOURCE_AGE_MS
    || (risk.fetchedAt !== undefined && (now - risk.fetchedAt < 0 || now - risk.fetchedAt > MAX_SOURCE_AGE_MS))) return { eligible: false, reason: "stale_or_invalid_evidence" };
  const dexTrades = (dex.buys24h ?? 0) + (dex.sells24h ?? 0);
  const geckoTrades = gecko.buys24h + gecko.sells24h;
  if (!positiveMetric(dex.priceUsd, MAX_MARKET_PRICE_USD) || !positiveMetric(gecko.priceUsd, MAX_MARKET_PRICE_USD)
    || !positiveMetric(dex.liquidityUsd, MAX_MARKET_METRIC_USD) || !positiveMetric(gecko.liquidityUsd, MAX_MARKET_METRIC_USD)
    || !positiveMetric(dex.volume24hUsd, MAX_MARKET_METRIC_USD) || !positiveMetric(gecko.volume24hUsd, MAX_MARKET_METRIC_USD)
    || !count(dex.buys24h) || dex.buys24h <= 0 || !count(dex.sells24h) || dex.sells24h <= 0
    || !count(gecko.buys24h) || gecko.buys24h <= 0 || !count(gecko.sells24h) || gecko.sells24h <= 0
    || dex.liquidityUsd < MIN_TRUSTED_LIQUIDITY_USD || gecko.liquidityUsd < MIN_TRUSTED_LIQUIDITY_USD
    || dex.volume24hUsd < MIN_DEX_VOLUME_24H_USD || gecko.volume24hUsd < MIN_DEX_VOLUME_24H_USD
    || dexTrades < MIN_DEX_TRADES_24H || geckoTrades < MIN_DEX_TRADES_24H) return { eligible: false, reason: "insufficient_or_malformed_market_activity" };
  if (!validPrice(dex.priceUsd) || !validPrice(gecko.priceUsd) || !pricesAgree(dex.priceUsd, gecko.priceUsd)) return { eligible: false, reason: "conflicting_market_prices" };
  const riskKnown = hasKnownRiskSignal(risk.fields);
  return { eligible: true, reason: "corroborated_market_evidence", riskStatus: riskKnown ? "no_explicit_adverse_flag" : "unknown" };
}

type CacheEntry<T> = { expiresAt: number; value: T };
export class EvidenceCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  get<T>(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) { this.entries.delete(key); return undefined; }
    return entry.value as T;
  }
  set<T>(key: string, value: T, now = Date.now(), ttlMs = MARKET_EVIDENCE_CACHE_MS): void {
    if (!this.entries.has(key) && this.entries.size >= MARKET_EVIDENCE_MAX_CACHE_ENTRIES) {
      for (const [storedKey, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(storedKey);
      if (this.entries.size >= MARKET_EVIDENCE_MAX_CACHE_ENTRIES) this.entries.delete(this.entries.keys().next().value as string);
    }
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }
}
export const marketEvidenceCache = new EvidenceCache();
export const acquireGeckoRequestSlot = createRateGate(GECKO_MIN_INTERVAL_MS);
export const acquireGoPlusRequestSlot = createRateGate(GOPLUS_MIN_INTERVAL_MS);
export const GOPLUS_RATE_LIMIT_COOLDOWN_MS = 10_000;

export type JsonRequest = (url: string, timeoutMs: number) => Promise<{ data?: unknown; status?: number }>;
export type Wait = (ms: number) => Promise<void>;
export type RequestSlot = (() => Promise<void>) & { extendCooldown?: (ms: number) => void };
export function createRateGate(minIntervalMs: number, wait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), clock: () => number = Date.now): RequestSlot {
  let nextAllowedAt = 0;
  let queue = Promise.resolve();
  const acquire: RequestSlot = () => {
    const result = queue.then(async () => {
      let delay = Math.max(0, nextAllowedAt - clock());
      while (delay > 0) {
        await wait(delay);
        // A provider cooldown may have been extended while this slot was waiting.
        delay = Math.max(0, nextAllowedAt - clock());
      }
      nextAllowedAt = clock() + minIntervalMs;
    });
    queue = result.catch(() => undefined);
    return result;
  };
  acquire.extendCooldown = (ms: number) => {
    if (Number.isFinite(ms) && ms > 0) nextAllowedAt = Math.max(nextAllowedAt, clock() + ms);
  };
  return acquire;
}
async function requestWithRetry(url: string, timeoutMs: number, request: JsonRequest, acquire: () => Promise<void>): Promise<{ response: Awaited<ReturnType<JsonRequest>>; attempts: number }> {
  let lastFailure: "timeout" | "transport_or_request_exception" = "transport_or_request_exception";
  for (let attempt = 0; attempt < 2; attempt++) {
    await acquire();
    try {
      const response = await request(url, timeoutMs);
      if (response.status !== undefined && (response.status === 429 || response.status >= 500) && attempt === 0) continue;
      return { response, attempts: attempt + 1 };
    } catch (error) {
      lastFailure = requestErrorCategory(error);
      if (attempt === 1) throw new Error(lastFailure);
    }
  }
  throw new Error(lastFailure);
}

function requestErrorCategory(error: unknown): "timeout" | "transport_or_request_exception" {
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  if (candidate?.code === "ECONNABORTED" || candidate?.code === "ETIMEDOUT" || candidate?.code === "ERR_CANCELED"
    || candidate?.name === "AbortError" || /timeout|timed out|aborted/i.test(String(candidate?.message ?? ""))) return "timeout";
  return "transport_or_request_exception";
}

function safeProviderErrorCategory(message: unknown): NonNullable<GoPlusRiskDiagnostic["providerErrorCategory"]> {
  const normalized = typeof message === "string" ? message.toLowerCase() : "";
  if (/rate.?limit|request.?limit|too many requests|quota|limit exceeded/.test(normalized)) return "rate_limited";
  if (/unauthori[sz]ed|forbidden|authenticat|credential|access token/.test(normalized)) return "authentication_or_authorization";
  if (/unsupported|not supported|token not found|chain not supported/.test(normalized)) return "unsupported_token_or_chain";
  if (/invalid (address|contract|parameter|request)|bad request/.test(normalized)) return "invalid_request";
  return "provider_error";
}

function scalarResponseCode(code: unknown): code is number | string {
  return typeof code === "number" ? Number.isFinite(code) : typeof code === "string";
}

function normalizedGoPlusCode(code: number | string): string {
  return String(code).trim();
}

function safeResponseDiagnostic(body: Record<string, unknown>, token: string): Pick<GoPlusRiskDiagnostic,
  "responseCodeType" | "normalizedCodeCategory" | "responseCodeCategory" | "resultContainerPresent" | "tokenEntryPresent" | "providerErrorCategory"> {
  const hasCode = Object.hasOwn(body, "code");
  const code = body.code;
  const result = body.result;
  const resultContainerPresent = !!result && typeof result === "object" && !Array.isArray(result);
  const tokenEntryPresent = resultContainerPresent
    && Object.keys(result as Record<string, unknown>).some((addressKey) => normalizeTokenAddress(addressKey) === token);
  const codeType: GoPlusRiskDiagnostic["responseCodeType"] = !hasCode ? "missing"
    : code === null ? "null"
      : Array.isArray(code) ? "array"
        : typeof code as NonNullable<GoPlusRiskDiagnostic["responseCodeType"]>;
  const normalizedCodeCategory: GoPlusRiskDiagnostic["normalizedCodeCategory"] = !hasCode
    ? "missing"
    : scalarResponseCode(code) && normalizedGoPlusCode(code) === "1" ? "success" : "non_success";
  const providerErrorCategory = normalizedCodeCategory === "non_success"
    && !(scalarResponseCode(code) && normalizedGoPlusCode(code) === "2")
    ? scalarResponseCode(code) && normalizedGoPlusCode(code) === "4029"
      ? "rate_limited" as const
      : safeProviderErrorCategory(body.message)
    : undefined;
  const responseCodeCategory: GoPlusRiskDiagnostic["responseCodeCategory"] = !hasCode ? "missing"
    : !scalarResponseCode(code) ? "malformed"
      : normalizedGoPlusCode(code) === "1" ? "success_1"
        : normalizedGoPlusCode(code) === "2" ? "partial_2"
          : normalizedGoPlusCode(code) === "4029" ? "request_limit_4029"
            : providerErrorCategory === "rate_limited" ? "rate_limited_other_code" : "other_scalar";
  return {
    responseCodeType: codeType,
    normalizedCodeCategory,
    resultContainerPresent,
    tokenEntryPresent,
    ...(providerErrorCategory === "rate_limited" ? { responseCodeCategory } : {}),
    ...(providerErrorCategory ? { providerErrorCategory } : {}),
  };
}

async function requestGoPlusWithRetry(
  url: string,
  timeoutMs: number,
  request: JsonRequest,
  acquire: RequestSlot,
  wait: Wait,
): Promise<{ response?: Awaited<ReturnType<JsonRequest>>; diagnostic: GoPlusRiskDiagnostic }> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await acquire();
      const response = await request(url, timeoutMs);
      const retryableHttpStatus = response.status !== undefined && (response.status === 429 || response.status >= 500);
      const body = response.data;
      const bodyRecord = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
      const responseCode = bodyRecord?.code;
      const validScalarCode = scalarResponseCode(responseCode);
      const normalizedCode = validScalarCode ? normalizedGoPlusCode(responseCode) : "";
      const applicationRateLimit = response.status === 200 && validScalarCode
        && normalizedCode !== "2"
        && (normalizedCode === "4029" || safeProviderErrorCategory(bodyRecord?.message) === "rate_limited");
      const partialData = response.status === 200 && validScalarCode && normalizedCode === "2";
      if (attempt === 1 && (retryableHttpStatus || applicationRateLimit || partialData)) {
        // HTTP failures already pass through the shared request gate; give GoPlus
        // application-level limits and partial responses a bounded backoff.
        if (partialData) await wait(15_000);
        else if (applicationRateLimit) {
          // Pause the shared queue as well as this retry so concurrent token lookups
          // do not all resume together after an application-level limit.
          acquire.extendCooldown?.(GOPLUS_RATE_LIMIT_COOLDOWN_MS);
          await wait(2_000);
        }
        continue;
      }
      return {
        response,
        diagnostic: {
          category: "success",
          attempts: attempt,
          ...(response.status === undefined ? {} : { httpStatus: response.status }),
        },
      };
    } catch (error) {
      if (attempt === 2) {
        return { diagnostic: { category: requestErrorCategory(error), attempts: attempt } };
      }
    }
  }
  return { diagnostic: { category: "transport_or_request_exception", attempts: 2 } };
}

type GeckoPool = { id?: unknown; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id?: unknown } }> };
function parseGeckoPool(raw: unknown, tokenAddress: string, poolAddress: string, fetchedAt: number): GeckoMarketQuote | undefined {
  const row = raw as GeckoPool;
  const attrs = row?.attributes;
  const relationships = row?.relationships;
  const id = typeof row?.id === "string" ? row.id : "";
  const [chain, idPool] = id.split("_");
  const pool = normalizeTokenAddress(idPool);
  const base = normalizeTokenAddress(relationships?.base_token?.data?.id?.toString().split("_").at(-1));
  const quote = normalizeTokenAddress(relationships?.quote_token?.data?.id?.toString().split("_").at(-1));
  const token = normalizeTokenAddress(tokenAddress);
  const price = Number(attrs?.base_token_price_usd);
  const liquidity = Number(attrs?.reserve_in_usd);
  const volume = Number((attrs?.volume_usd as Record<string, unknown> | undefined)?.h24);
  const buys = Number((attrs?.transactions as Record<string, Record<string, unknown>> | undefined)?.h24?.buys);
  const sells = Number((attrs?.transactions as Record<string, Record<string, unknown>> | undefined)?.h24?.sells);
  if (chain !== "base" || !pool || pool !== normalizeTokenAddress(poolAddress) || !token || base !== token || !quote
    || !positiveMetric(price, MAX_MARKET_PRICE_USD) || !positiveMetric(liquidity, MAX_MARKET_METRIC_USD)
    || !positiveMetric(volume, MAX_MARKET_METRIC_USD) || !count(buys) || !count(sells)) return undefined;
  return { chainId: BASE_CHAIN_ID, tokenAddress: token, poolAddress: pool, baseTokenAddress: base, quoteTokenAddress: quote, priceUsd: price, liquidityUsd: liquidity, volume24hUsd: volume, buys24h: buys, sells24h: sells, fetchedAt };
}

// GeckoTerminal's /pools/multi endpoint lets one bounded request verify several
// exact DexScreener pool addresses. Cache identity includes chain, token, pool.
export async function fetchGeckoMarketEvidenceDetailed(
  entries: Array<{ tokenAddress: string; poolAddress: string }>, request: JsonRequest, cache: EvidenceCache, acquire: () => Promise<void>, now = Date.now(),
): Promise<{ quotes: Record<string, GeckoMarketQuote>; diagnostics: Record<string, GeckoPoolDiagnostic> }> {
  const valid = entries.slice(0, MAX_MARKET_POOL_REQUESTS).flatMap((entry) => {
    const token = normalizeTokenAddress(entry.tokenAddress); const pool = normalizeTokenAddress(entry.poolAddress);
    return token && pool ? [{ token, pool }] : [];
  });
  const output: Record<string, GeckoMarketQuote> = {};
  const diagnostics: Record<string, GeckoPoolDiagnostic> = {};
  const missing: typeof valid = [];
  for (const entry of valid) {
    const key = marketEvidencePoolKey(entry.token, entry.pool);
    const cached = cache.get<GeckoMarketQuote>(`gecko:base:${entry.token}:${entry.pool}`, now);
    if (cached) { output[key] = cached; diagnostics[key] = { status: "cached" }; }
    else missing.push(entry);
  }
  for (let offset = 0; offset < missing.length; offset += MARKET_EVIDENCE_LIMIT) {
    const batch = missing.slice(offset, offset + MARKET_EVIDENCE_LIMIT);
    try {
      const ids = [...new Set(batch.map((entry) => entry.pool))];
      const url = `${GECKOTERMINAL_BASE_URL}/networks/base/pools/multi/${ids.join(",")}?include=base_token,quote_token`;
      const { response, attempts } = await requestWithRetry(url, 8_000, request, acquire);
      const rows = (response.data as { data?: unknown[] } | undefined)?.data;
      const badStatus = response.status !== undefined && (response.status < 200 || response.status >= 300);
      const validRows = Array.isArray(rows);
      for (const entry of batch) {
        const key = marketEvidencePoolKey(entry.token, entry.pool);
        if (badStatus) {
          diagnostics[key] = { status: "provider_failure", category: "non_2xx_http_status", httpStatus: response.status, attempts };
          continue;
        }
        if (!validRows) { diagnostics[key] = { status: "provider_failure", category: "malformed_response", httpStatus: response.status, attempts }; continue; }
        const poolId = `base_${entry.pool}`;
        const row = rows.find((candidate) => (candidate as GeckoPool)?.id?.toString().toLowerCase() === poolId);
        if (!row) { diagnostics[key] = { status: "missing_data", httpStatus: response.status, attempts }; continue; }
        const quote = parseGeckoPool(row, entry.token, entry.pool, now);
        if (quote) {
          output[key] = quote; diagnostics[key] = { status: "available", httpStatus: response.status, attempts };
          cache.set(`gecko:base:${entry.token}:${entry.pool}`, quote, now);
        } else {
          const base = normalizeTokenAddress((row as GeckoPool)?.relationships?.base_token?.data?.id?.toString().split("_").at(-1));
          diagnostics[key] = { status: base && base !== entry.token ? "pool_identity_mismatch" : "malformed_data", httpStatus: response.status, attempts };
        }
      }
    } catch (error) {
      const diagnostic: GeckoPoolDiagnostic = { status: "provider_failure", category: error instanceof Error && (error.message === "timeout" || error.message === "transport_or_request_exception") ? error.message : "transport_or_request_exception", attempts: 2 };
      for (const entry of batch) diagnostics[marketEvidencePoolKey(entry.token, entry.pool)] = diagnostic;
    }
  }
  return { quotes: output, diagnostics };
}

// Compatibility helper for single-pool callers. Multi-pool integrations should
// use the exact token/pool key returned by fetchGeckoMarketEvidenceDetailed.
export async function fetchGeckoMarketEvidence(
  entries: Array<{ tokenAddress: string; poolAddress: string }>, request: JsonRequest, cache: EvidenceCache, acquire: () => Promise<void>, now = Date.now(),
): Promise<Record<string, GeckoMarketQuote>> {
  const detailed = await fetchGeckoMarketEvidenceDetailed(entries, request, cache, acquire, now);
  const output: Record<string, GeckoMarketQuote> = {};
  for (const entry of entries.slice(0, MARKET_EVIDENCE_LIMIT)) {
    const token = normalizeTokenAddress(entry.tokenAddress); const pool = normalizeTokenAddress(entry.poolAddress);
    if (token && pool) { const quote = detailed.quotes[marketEvidencePoolKey(token, pool)]; if (quote) output[token] = quote; }
  }
  return output;
}

export async function fetchGoPlusRisk(address: string, request: JsonRequest, cache: EvidenceCache, acquire: RequestSlot, now = Date.now(), retryWait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<GoPlusRisk> {
  const token = normalizeTokenAddress(address);
  if (!token) return { status: "unavailable", fields: {}, diagnostic: { category: "invalid_token_address", attempts: 0 } };
  const key = `goplus:8453:${token}`;
  const cached = cache.get<GoPlusRisk>(key, now);
  if (cached) return cached;
  const requestResult = await requestGoPlusWithRetry(`${GOPLUS_BASE_URL}?contract_addresses=${token}`, 8_000, request, acquire, retryWait);
  if (!requestResult.response) return { status: "unavailable", fields: {}, diagnostic: requestResult.diagnostic };
  const response = requestResult.response;
  const withDiagnostic = (result: Omit<GoPlusRisk, "diagnostic">, category: GoPlusDiagnosticCategory): GoPlusRisk => ({
    ...result,
    diagnostic: { ...requestResult.diagnostic, category },
  });
  if (response.status !== undefined && (response.status < 200 || response.status >= 300)) {
    return {
      ...withDiagnostic({ status: "unavailable", fields: {} }, "non_2xx_http_status"),
      diagnostic: {
        ...requestResult.diagnostic,
        category: "non_2xx_http_status",
        ...(response.status === 429 ? { providerErrorCategory: "rate_limited" as const } : {}),
      },
    };
  }
  const body = response.data;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return withDiagnostic({ status: "unavailable", fields: {} }, "unexpected_response_shape");
  }
  const bodyRecord = body as Record<string, unknown>;
  if (!Object.hasOwn(bodyRecord, "code") || !scalarResponseCode(bodyRecord.code)) {
    return { ...withDiagnostic({ status: "unavailable", fields: {} }, "unexpected_response_shape"), diagnostic: { ...requestResult.diagnostic, category: "unexpected_response_shape", ...safeResponseDiagnostic(bodyRecord, token) } };
  }
  const responseCode = normalizedGoPlusCode(bodyRecord.code);
  if (responseCode !== "1") {
    const responseDiagnostics = safeResponseDiagnostic(bodyRecord, token);
    const category = responseCode === "2" ? "partial_data"
      : responseDiagnostics.providerErrorCategory === "rate_limited" ? "application_rate_limit" : "unexpected_api_code";
    return { ...withDiagnostic({ status: "unavailable", fields: {} }, category), diagnostic: { ...requestResult.diagnostic, category, ...responseDiagnostics } };
  }
  const responseDiagnostics = safeResponseDiagnostic(bodyRecord, token);
  const result = bodyRecord.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ...withDiagnostic({ status: "unavailable", fields: {} }, "unexpected_response_shape"), diagnostic: { ...requestResult.diagnostic, category: "unexpected_response_shape", ...responseDiagnostics } };
  }
  const rawEntry = Object.entries(result as Record<string, unknown>)
    .find(([addressKey]) => normalizeTokenAddress(addressKey) === token)?.[1];
  if (rawEntry === undefined) return { ...withDiagnostic({ status: "unavailable", fields: {} }, "missing_token_entry"), diagnostic: { ...requestResult.diagnostic, category: "missing_token_entry", ...responseDiagnostics } };
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return { ...withDiagnostic({ status: "unavailable", fields: {} }, "unexpected_response_shape"), diagnostic: { ...requestResult.diagnostic, category: "unexpected_response_shape", ...responseDiagnostics } };
  }
  const binaryKeys = new Set(["is_open_source", "is_honeypot", "cannot_buy", "cannot_sell", "cannot_sell_all", "trading_cooldown", "is_blacklisted", "is_whitelisted", "is_anti_whale", "transfer_pausable", "slippage_modifiable", "is_buyable", "is_sellable"]);
  const taxKeys = new Set(["buy_tax", "sell_tax"]);
  let malformed = false;
  const fields = Object.fromEntries(Object.entries(rawEntry as Record<string, unknown>).flatMap(([name, value]) => {
    if (binaryKeys.has(name) && typeof value !== "string") { malformed = true; return []; }
    if (taxKeys.has(name) && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) { malformed = true; return []; }
    if (typeof value === "string" && value.length < 100) return [[name, value]];
    if (typeof value === "number" && Number.isFinite(value)) return [[name, String(value)]];
    if (binaryKeys.has(name) || taxKeys.has(name)) malformed = true;
    return [];
  }));
  if (malformed) return { ...withDiagnostic({ status: "malformed", fields }, "malformed_risk_fields"), diagnostic: { ...requestResult.diagnostic, category: "malformed_risk_fields", ...responseDiagnostics } };
  const risk: GoPlusRisk = { ...withDiagnostic({ status: "available", fields, fetchedAt: now }, "success"), diagnostic: { ...requestResult.diagnostic, category: "success", ...responseDiagnostics } };
  cache.set(key, risk, now);
  return risk;
}
