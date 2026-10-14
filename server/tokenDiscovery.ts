import axios, { type AxiosRequestConfig } from "axios";

export type DiscoverySource = "alchemy" | "alchemy-transfers" | "blockscout-balances" | "blockscout-transfers";
export type DiscoveryStatus = "success" | "partial" | "failed" | "timeout" | "capped" | "disabled";

export type DiscoveryCandidate = {
  address: string;
  sources: DiscoverySource[];
  logoURI?: string;
};

export type ProviderResult = {
  source: DiscoverySource;
  status: DiscoveryStatus;
  candidates: DiscoveryCandidate[];
  pages: number;
  diagnostic?: string;
  blockscoutQuotes?: Record<string, BlockscoutQuote>;
  blockscoutLogos?: Record<string, string>;
  blockscoutLogoDiagnostics?: BlockscoutLogoDiagnostics;
};

export type BlockscoutQuote = {
  priceUsd?: number;
  reputation?: string;
  volume24h?: number;
};

export type BlockscoutLogoDiagnostics = {
  itemCount: number;
  tokenObjectCount: number;
  addressHashFieldCount: number;
  addressFieldCount: number;
  iconUrlFieldCount: number;
  logoUrlFieldCount: number;
  usableIconUrlCount: number;
};

export type DiscoveryResponse = {
  status: "success" | "partial_success" | "discovery_unavailable";
  tokens: DiscoveryCandidate[];
  discovery: { sources: ProviderResult[] };
  blockscoutQuotes?: Record<string, BlockscoutQuote>;
  blockscoutLogos?: Record<string, string>;
};

export function discoveryHttpStatus(response: Pick<DiscoveryResponse, "status">): 200 | 503 {
  return response.status === "discovery_unavailable" ? 503 : 200;
}

export type DiscoveryRequest = (config: AxiosRequestConfig) => Promise<{ data: unknown; status?: number }>;

export type TokenDiscoveryConfig = {
  alchemyApiKey?: string;
  request?: DiscoveryRequest;
  now?: () => number;
  alchemyBudgetMs?: number;
  blockscoutBalancesBudgetMs?: number;
  blockscoutTransfersBudgetMs?: number;
  requestTimeoutMs?: number;
  maxPages?: number;
  maxCandidates?: number;
};

const BASE_BLOCKSCOUT = "https://base.blockscout.com/api/v2";
const ALCHEMY_BASE = "https://base-mainnet.g.alchemy.com/v2";
const NATIVE_SENTINELS = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
]);

const defaults = {
  alchemyBudgetMs: 8_000,
  blockscoutBalancesBudgetMs: 4_000,
  blockscoutTransfersBudgetMs: 6_000,
  requestTimeoutMs: 3_000,
  maxPages: 10,
  maxCandidates: 1_000,
};

function options(config: TokenDiscoveryConfig) {
  return { ...defaults, ...config, now: config.now || Date.now, request: config.request || axios.request };
}

export function isValidTokenAddress(value: unknown): value is string {
  return typeof value === "string"
    && /^0x[0-9a-fA-F]{40}$/.test(value)
    && !NATIVE_SENTINELS.has(value.toLowerCase());
}

export function blockscoutQuotesFromBalanceItems(items: unknown[]): Record<string, BlockscoutQuote> {
  const quotes: Record<string, BlockscoutQuote> = {};
  for (const item of items as Array<{ token?: { type?: unknown; address_hash?: unknown; exchange_rate?: unknown; reputation?: unknown; volume_24h?: unknown } }>) {
    const token = item?.token;
    const priceUsd = Number(token?.exchange_rate);
    if (token?.type !== "ERC-20" || !isValidTokenAddress(token?.address_hash)) continue;
    const reputation = typeof token.reputation === "string" ? token.reputation : undefined;
    const volume24h = Number(token.volume_24h);
    quotes[token.address_hash.toLowerCase()] = {
      ...(Number.isFinite(priceUsd) && priceUsd > 0 ? { priceUsd } : {}),
      ...(reputation === undefined ? {} : { reputation }),
      ...(Number.isFinite(volume24h) ? { volume24h } : {}),
    };
  }
  return quotes;
}

export function blockscoutLogosFromBalanceItems(items: unknown[]): Record<string, string> {
  const logos: Record<string, string> = {};
  for (const item of items as Array<{ token?: { type?: unknown; address_hash?: unknown; icon_url?: unknown } }>) {
    const token = item?.token;
    if (token?.type !== "ERC-20" || !isValidTokenAddress(token.address_hash)) continue;
    if (typeof token.icon_url === "string" && /^https?:\/\//i.test(token.icon_url.trim())) {
      logos[token.address_hash.toLowerCase()] = token.icon_url.trim();
    }
  }
  return logos;
}

export function diagnoseBlockscoutLogoItems(items: unknown[]): BlockscoutLogoDiagnostics {
  const diagnostics: BlockscoutLogoDiagnostics = {
    itemCount: items.length,
    tokenObjectCount: 0,
    addressHashFieldCount: 0,
    addressFieldCount: 0,
    iconUrlFieldCount: 0,
    logoUrlFieldCount: 0,
    usableIconUrlCount: 0,
  };
  for (const item of items as Array<{ token?: unknown }>) {
    if (!item?.token || typeof item.token !== "object" || Array.isArray(item.token)) continue;
    diagnostics.tokenObjectCount += 1;
    const token = item.token as Record<string, unknown>;
    if (Object.hasOwn(token, "address_hash")) diagnostics.addressHashFieldCount += 1;
    if (Object.hasOwn(token, "address")) diagnostics.addressFieldCount += 1;
    if (Object.hasOwn(token, "icon_url")) diagnostics.iconUrlFieldCount += 1;
    if (Object.hasOwn(token, "logo_url")) diagnostics.logoUrlFieldCount += 1;
    if (typeof token.icon_url === "string" && /^https?:\/\//i.test(token.icon_url.trim())) diagnostics.usableIconUrlCount += 1;
  }
  return diagnostics;
}

function candidatesFromAddresses(addresses: unknown[], source: DiscoverySource): DiscoveryCandidate[] {
  const found = new Map<string, DiscoveryCandidate>();
  for (const address of addresses) {
    if (!isValidTokenAddress(address)) continue;
    found.set(address.toLowerCase(), { address, sources: [source] });
  }
  return [...found.values()];
}

function errorStatus(error: unknown): "failed" | "timeout" {
  const candidate = error as { code?: string; message?: string };
  return candidate?.code === "ECONNABORTED" || candidate?.code === "ERR_CANCELED" || /timeout|aborted/i.test(candidate?.message || "")
    ? "timeout"
    : "failed";
}

function diagnostic(error: unknown): string {
  const candidate = error as { response?: { status?: number; headers?: Record<string, unknown>; data?: unknown } };
  const status = candidate?.response?.status;
  const headers = candidate?.response?.headers;
  const mitigated = headers && Object.entries(headers).find(([name]) => name.toLowerCase() === "cf-mitigated")?.[1];
  const body = typeof candidate?.response?.data === "string" ? candidate.response.data : "";
  if (status === 403 && (String(mitigated).toLowerCase() === "challenge" || /<title>just a moment/i.test(body))) {
    return "HTTP 403: Cloudflare challenge blocked the Blockscout API request";
  }
  if (status) return `HTTP ${status}: provider request failed`;
  return errorStatus(error) === "timeout" ? "Provider request timed out" : "Provider request failed";
}

function transient(error: unknown): boolean {
  const candidate = error as { response?: { status?: number }; code?: string; message?: string };
  const status = candidate?.response?.status;
  return candidate?.code === "ECONNABORTED" || candidate?.code === "ERR_CANCELED" || status === 429 || !!(status && status >= 500) || /timeout/i.test(candidate?.message || "");
}

async function boundedRequest(config: TokenDiscoveryConfig, deadline: number, requestConfig: AxiosRequestConfig) {
  const opt = options(config);
  let attempt = 0;
  let lastError: unknown;
  while (attempt < 2) {
    const remaining = deadline - opt.now();
    if (remaining <= 0) throw Object.assign(new Error("provider deadline reached"), { code: "ECONNABORTED" });
    const controller = new AbortController();
    const timeout = Math.min(opt.requestTimeoutMs, remaining);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await opt.request({ ...requestConfig, timeout, signal: controller.signal });
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (!transient(error) || attempt >= 2 || deadline - opt.now() <= Math.max(250, opt.requestTimeoutMs / 3)) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function malformed(source: DiscoverySource, pages: number, message: string, addresses: unknown[] = []): ProviderResult {
  return {
    source,
    status: pages > 0 ? "partial" : "failed",
    candidates: candidatesFromAddresses(addresses, source),
    pages,
    diagnostic: `Malformed response: ${message}`,
  };
}

export async function discoverAlchemyTokens(address: string, config: TokenDiscoveryConfig = {}): Promise<ProviderResult> {
  const source: DiscoverySource = "alchemy";
  const opt = options(config);
  if (!opt.alchemyApiKey) return { source, status: "disabled", candidates: [], pages: 0, diagnostic: "ALCHEMY_API_KEY is not configured" };
  const deadline = opt.now() + opt.alchemyBudgetMs;
  const addresses: unknown[] = [];
  let pageKey: string | undefined;
  let pages = 0;
  try {
    do {
      const params: unknown[] = [address, "erc20"];
      if (pageKey) params.push({ pageKey });
      const response = await boundedRequest(config, deadline, {
        method: "POST", url: `${ALCHEMY_BASE}/${opt.alchemyApiKey}`,
        data: { jsonrpc: "2.0", method: "alchemy_getTokenBalances", params, id: 1 },
      });
      const body = response.data as { result?: { tokenBalances?: unknown[]; pageKey?: unknown }; error?: { message?: string } };
      if (!body || typeof body !== "object" || body.error || !Array.isArray(body.result?.tokenBalances)) {
        return malformed(source, pages, "invalid response envelope", addresses);
      }
      for (const token of body.result.tokenBalances as Array<{ contractAddress?: unknown }>) addresses.push(token?.contractAddress);
      pages += 1;
      if (body.result.pageKey !== undefined && body.result.pageKey !== null && typeof body.result.pageKey !== "string") {
        return malformed(source, pages, "invalid pageKey", addresses);
      }
      pageKey = typeof body.result.pageKey === "string" && body.result.pageKey ? body.result.pageKey : undefined;
      const candidates = candidatesFromAddresses(addresses, source);
      if (candidates.length >= opt.maxCandidates) return { source, status: "capped", candidates: candidates.slice(0, opt.maxCandidates), pages, diagnostic: "candidate cap reached" };
    } while (pageKey && pages < opt.maxPages && opt.now() < deadline);
    if (pageKey && (pages >= opt.maxPages || opt.now() >= deadline)) return { source, status: "capped", candidates: candidatesFromAddresses(addresses, source), pages, diagnostic: pages >= opt.maxPages ? "page cap reached" : "provider deadline reached" };
    return { source, status: "success", candidates: candidatesFromAddresses(addresses, source), pages };
  } catch (error) {
    return { source, status: errorStatus(error), candidates: candidatesFromAddresses(addresses, source), pages, diagnostic: diagnostic(error) };
  }
}

export async function discoverAlchemyTransfers(address: string, config: TokenDiscoveryConfig = {}): Promise<ProviderResult> {
  const source: DiscoverySource = "alchemy-transfers";
  const opt = options(config);
  if (!opt.alchemyApiKey) return { source, status: "disabled", candidates: [], pages: 0, diagnostic: "ALCHEMY_API_KEY is not configured" };
  const deadline = opt.now() + opt.alchemyBudgetMs;
  const addresses: unknown[] = [];
  let pageKey: string | undefined;
  let pages = 0;
  try {
    do {
      const response = await boundedRequest(config, deadline, { method: "POST", url: `${ALCHEMY_BASE}/${opt.alchemyApiKey}`, data: { jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", fromAddress: address, category: ["erc20"], withMetadata: false, maxCount: "0x64", ...(pageKey ? { pageKey } : {}) }] } });
      const body = response.data as { result?: { transfers?: Array<{ rawContract?: { address?: unknown } }>; pageKey?: unknown }; error?: unknown };
      if (!body || body.error || !Array.isArray(body.result?.transfers)) return malformed(source, pages, "invalid response envelope", addresses);
      for (const transfer of body.result.transfers) addresses.push(transfer.rawContract?.address);
      pages += 1;
      if (body.result.pageKey !== undefined && body.result.pageKey !== null && typeof body.result.pageKey !== "string") {
        return malformed(source, pages, "invalid pageKey", addresses);
      }
      pageKey = typeof body.result.pageKey === "string" && body.result.pageKey ? body.result.pageKey : undefined;
      if (candidatesFromAddresses(addresses, source).length >= opt.maxCandidates) return { source, status: "capped", candidates: candidatesFromAddresses(addresses, source).slice(0, opt.maxCandidates), pages, diagnostic: "candidate cap reached" };
    } while (pageKey && pages < opt.maxPages && opt.now() < deadline);
    const candidates = candidatesFromAddresses(addresses, source);
    return { source, status: pageKey ? "capped" : "success", candidates, pages, ...(pageKey ? { diagnostic: pages >= opt.maxPages ? "page cap reached" : "provider deadline reached" } : {}) };
  } catch (error) { return { source, status: errorStatus(error), candidates: candidatesFromAddresses(addresses, source), pages, diagnostic: diagnostic(error) }; }
}

export async function discoverBlockscoutBalances(address: string, config: TokenDiscoveryConfig = {}): Promise<ProviderResult> {
  const source: DiscoverySource = "blockscout-balances";
  const opt = options(config);
  const deadline = opt.now() + opt.blockscoutBalancesBudgetMs;
  try {
    const response = await boundedRequest(config, deadline, { method: "GET", url: `${BASE_BLOCKSCOUT}/addresses/${address}/token-balances` });
    const body = response.data as unknown;
    const items = Array.isArray(body) ? body : (body as { items?: unknown[] })?.items;
    if (!Array.isArray(items)) return malformed(source, 0, "missing items array");
    const candidates = candidatesFromAddresses(items.filter((item: any) => item?.token?.type === "ERC-20").map((item: any) => item.token.address_hash), source);
    return {
      source,
      status: candidates.length >= opt.maxCandidates ? "capped" : "success",
      candidates: candidates.slice(0, opt.maxCandidates),
      pages: 1,
      ...(candidates.length >= opt.maxCandidates ? { diagnostic: "candidate cap reached" } : {}),
      blockscoutQuotes: blockscoutQuotesFromBalanceItems(items),
      blockscoutLogos: blockscoutLogosFromBalanceItems(items),
      blockscoutLogoDiagnostics: diagnoseBlockscoutLogoItems(items),
    };
  } catch (error) {
    return { source, status: errorStatus(error), candidates: [], pages: 0, diagnostic: diagnostic(error) };
  }
}

export async function discoverBlockscoutTransfers(address: string, config: TokenDiscoveryConfig = {}): Promise<ProviderResult> {
  const source: DiscoverySource = "blockscout-transfers";
  const opt = options(config);
  const deadline = opt.now() + opt.blockscoutTransfersBudgetMs;
  const addresses: unknown[] = [];
  let params: Record<string, unknown> = { limit: 50, type: "ERC-20" };
  let pages = 0;
  try {
    while (pages < opt.maxPages && opt.now() < deadline) {
      const response = await boundedRequest(config, deadline, { method: "GET", url: `${BASE_BLOCKSCOUT}/addresses/${address}/token-transfers`, params });
      const body = response.data as { items?: unknown[]; next_page_params?: unknown } | unknown[];
      const items = Array.isArray(body) ? body : body?.items;
      if (!Array.isArray(items)) return malformed(source, pages, "missing items array", addresses);
      for (const item of items as Array<{ token?: { address_hash?: unknown; type?: unknown } }>) {
        if (item?.token?.type === "ERC-20") addresses.push(item.token.address_hash);
      }
      pages += 1;
      const candidates = candidatesFromAddresses(addresses, source);
      if (candidates.length >= opt.maxCandidates) return { source, status: "capped", candidates: candidates.slice(0, opt.maxCandidates), pages, diagnostic: "candidate cap reached" };
      const next = !Array.isArray(body) && body?.next_page_params;
      if (!next) return { source, status: "success", candidates: candidatesFromAddresses(addresses, source), pages };
      if (typeof next !== "object" || Array.isArray(next)) return malformed(source, pages, "invalid next_page_params", addresses);
      params = { ...(next as Record<string, unknown>) };
    }
    return { source, status: "capped", candidates: candidatesFromAddresses(addresses, source), pages, diagnostic: pages >= opt.maxPages ? "page cap reached" : "provider deadline reached" };
  } catch (error) {
    return { source, status: errorStatus(error), candidates: candidatesFromAddresses(addresses, source), pages, diagnostic: diagnostic(error) };
  }
}

export function mergeDiscoveryCandidates(results: ProviderResult[]): DiscoveryCandidate[] {
  const merged = new Map<string, DiscoveryCandidate>();
  for (const result of results) for (const candidate of result.candidates) {
    if (!isValidTokenAddress(candidate.address)) continue;
    const key = candidate.address.toLowerCase();
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, sources: [...new Set([...existing.sources, ...candidate.sources])] } : { ...candidate, sources: [...candidate.sources] });
  }
  return [...merged.values()];
}

export async function discoverBaseTokenCandidates(address: string, config: TokenDiscoveryConfig = {}): Promise<DiscoveryResponse> {
  const results = await Promise.all([
    discoverAlchemyTokens(address, config), discoverAlchemyTransfers(address, config), discoverBlockscoutBalances(address, config), discoverBlockscoutTransfers(address, config),
  ]);
  const enabled = results.filter((result) => result.status !== "disabled");
  const successful = results.filter((result) => result.status === "success");
  const usable = results.filter((result) => result.candidates.length > 0);
  const incomplete = results.some((result) => result.status === "partial" || result.status === "capped");
  const status: DiscoveryResponse["status"] = successful.length === enabled.length && enabled.length > 0
    ? "success"
    : usable.length > 0 || incomplete ? "partial_success" : "discovery_unavailable";
  const blockscoutQuotes = results.find((result) => result.source === "blockscout-balances")?.blockscoutQuotes;
  const blockscoutLogos = results.find((result) => result.source === "blockscout-balances")?.blockscoutLogos;
  const tokens = mergeDiscoveryCandidates(results).map((candidate) => ({
    ...candidate,
    ...(blockscoutLogos?.[candidate.address.toLowerCase()] ? { logoURI: blockscoutLogos[candidate.address.toLowerCase()] } : {}),
  }));
  return { status, tokens, discovery: { sources: results }, ...(blockscoutQuotes ? { blockscoutQuotes } : {}), ...(blockscoutLogos ? { blockscoutLogos } : {}) };
}
