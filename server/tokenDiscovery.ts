import axios, { type AxiosRequestConfig } from "axios";

export type DiscoverySource = "alchemy" | "moralis" | "blockscout-balances" | "blockscout-transfers";
export type DiscoveryStatus = "success" | "failed" | "timeout" | "capped" | "disabled";

export type DiscoveryCandidate = {
  address: string;
  sources: DiscoverySource[];
};

export type ProviderResult = {
  source: DiscoverySource;
  status: DiscoveryStatus;
  candidates: DiscoveryCandidate[];
  pages: number;
  diagnostic?: string;
};

export type DiscoveryResponse = {
  status: "success" | "partial_success" | "discovery_unavailable";
  tokens: DiscoveryCandidate[];
  discovery: { sources: ProviderResult[] };
};

export function discoveryHttpStatus(response: Pick<DiscoveryResponse, "status">): 200 | 503 {
  return response.status === "discovery_unavailable" ? 503 : 200;
}

export type DiscoveryRequest = (config: AxiosRequestConfig) => Promise<{ data: unknown; status?: number }>;

export type TokenDiscoveryConfig = {
  alchemyApiKey?: string;
  moralisApiKey?: string;
  request?: DiscoveryRequest;
  now?: () => number;
  alchemyBudgetMs?: number;
  moralisBudgetMs?: number;
  blockscoutBalancesBudgetMs?: number;
  blockscoutTransfersBudgetMs?: number;
  requestTimeoutMs?: number;
  maxPages?: number;
  maxCandidates?: number;
};

const BASE_BLOCKSCOUT = "https://base.blockscout.com/api/v2";
const ALCHEMY_BASE = "https://base-mainnet.g.alchemy.com/v2";
const MORALIS_BASE = "https://deep-index.moralis.io/api/v2.2";
const NATIVE_SENTINELS = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
]);

const defaults = {
  alchemyBudgetMs: 8_000,
  moralisBudgetMs: 8_000,
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
  const candidate = error as { response?: { status?: number }; message?: string };
  const status = candidate?.response?.status;
  return status ? `HTTP ${status}: ${candidate.message || "request failed"}` : candidate?.message || "request failed";
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

function malformed(source: DiscoverySource, pages: number, message: string): ProviderResult {
  return { source, status: "failed", candidates: [], pages, diagnostic: `Malformed response: ${message}` };
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
        return malformed(source, pages, body?.error?.message || "missing result.tokenBalances");
      }
      for (const token of body.result.tokenBalances as Array<{ contractAddress?: unknown }>) addresses.push(token?.contractAddress);
      pages += 1;
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

export async function discoverMoralisTokens(address: string, config: TokenDiscoveryConfig = {}): Promise<ProviderResult> {
  const source: DiscoverySource = "moralis";
  const opt = options(config);
  if (!opt.moralisApiKey) return { source, status: "disabled", candidates: [], pages: 0, diagnostic: "MORALIS_API_KEY is not configured" };
  const deadline = opt.now() + opt.moralisBudgetMs;
  const addresses: unknown[] = [];
  let cursor: string | undefined;
  let pages = 0;
  try {
    do {
      const response = await boundedRequest(config, deadline, {
        method: "GET", url: `${MORALIS_BASE}/wallets/${address}/tokens`,
        headers: { "X-API-Key": opt.moralisApiKey }, params: { chain: "0x2105", ...(cursor ? { cursor } : {}) },
      });
      const body = response.data as { result?: unknown[]; cursor?: unknown; error?: unknown; status?: unknown; syncStatus?: unknown; sync_status?: unknown; syncing?: unknown };
      if (!body || typeof body !== "object" || !Array.isArray(body.result)) return malformed(source, pages, "missing result array");
      const statusMetadata = [body.status, body.syncStatus, body.sync_status].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
      if (body.error || body.syncing === true || /fail|error|sync/.test(statusMetadata)) return malformed(source, pages, "provider reported failed sync/error metadata");
      for (const token of body.result as Array<{ token_address?: unknown; address?: unknown }>) addresses.push(token?.token_address ?? token?.address);
      pages += 1;
      cursor = typeof body.cursor === "string" && body.cursor ? body.cursor : undefined;
      const candidates = candidatesFromAddresses(addresses, source);
      if (candidates.length >= opt.maxCandidates) return { source, status: "capped", candidates: candidates.slice(0, opt.maxCandidates), pages, diagnostic: "candidate cap reached" };
    } while (cursor && pages < opt.maxPages && opt.now() < deadline);
    if (cursor && (pages >= opt.maxPages || opt.now() >= deadline)) return { source, status: "capped", candidates: candidatesFromAddresses(addresses, source), pages, diagnostic: pages >= opt.maxPages ? "page cap reached" : "provider deadline reached" };
    return { source, status: "success", candidates: candidatesFromAddresses(addresses, source), pages };
  } catch (error) {
    return { source, status: errorStatus(error), candidates: candidatesFromAddresses(addresses, source), pages, diagnostic: diagnostic(error) };
  }
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
    return { source, status: "success", candidates: candidatesFromAddresses(items.filter((item: any) => item?.token?.type === "ERC-20").map((item: any) => item.token.address_hash), source), pages: 1 };
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
      if (!Array.isArray(items)) return malformed(source, pages, "missing items array");
      for (const item of items as Array<{ token?: { address_hash?: unknown; type?: unknown } }>) {
        if (item?.token?.type === "ERC-20") addresses.push(item.token.address_hash);
      }
      pages += 1;
      const candidates = candidatesFromAddresses(addresses, source);
      if (candidates.length >= opt.maxCandidates) return { source, status: "capped", candidates: candidates.slice(0, opt.maxCandidates), pages, diagnostic: "candidate cap reached" };
      const next = !Array.isArray(body) && body?.next_page_params;
      if (!next) return { source, status: "success", candidates: candidatesFromAddresses(addresses, source), pages };
      if (typeof next !== "object" || Array.isArray(next)) return malformed(source, pages, "invalid next_page_params");
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
    discoverAlchemyTokens(address, config), discoverMoralisTokens(address, config), discoverBlockscoutBalances(address, config), discoverBlockscoutTransfers(address, config),
  ]);
  const enabled = results.filter((result) => result.status !== "disabled");
  const successful = results.filter((result) => result.status === "success");
  const status: DiscoveryResponse["status"] = successful.length === enabled.length && enabled.length > 0
    ? "success"
    : successful.length > 0 ? "partial_success" : "discovery_unavailable";
  return { status, tokens: mergeDiscoveryCandidates(results), discovery: { sources: results } };
}
