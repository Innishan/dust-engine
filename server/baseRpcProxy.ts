import axios from "axios";
import express, { type Express, type Request, type Response } from "express";

export const BASE_RPC_PROXY_PATH = "/api/base-rpc";
export const BASE_RPC_ALLOWED_METHODS = new Set(["eth_call", "eth_chainId"]);
export const BASE_RPC_MAX_BODY_BYTES = 32 * 1024;
export const BASE_RPC_RATE_LIMIT = 240;
export const BASE_RPC_RATE_WINDOW_MS = 60_000;
export const BASE_RPC_RATE_LIMIT_MAX_ENTRIES = 10_000;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: "eth_call" | "eth_chainId";
  params: unknown[];
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

type ProxyResult = { status: number; body: JsonRpcResponse; retryAfterSeconds?: number };

export type BaseRpcProxyOptions = {
  getRpcUrl: () => string | undefined;
  forward?: (rpcUrl: string, request: JsonRpcRequest) => Promise<unknown>;
  rateLimiter?: BaseRpcRateLimiter;
};

export class BaseRpcRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = BASE_RPC_RATE_LIMIT,
    private readonly windowMs = BASE_RPC_RATE_WINDOW_MS,
    private readonly maxEntries = BASE_RPC_RATE_LIMIT_MAX_ENTRIES,
  ) {}

  consume(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const existing = this.entries.get(key);
    if (!existing && this.entries.size >= this.maxEntries) {
      for (const [storedKey, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(storedKey);
      }
      if (this.entries.size >= this.maxEntries) {
        return { allowed: false, retryAfterSeconds: Math.ceil(this.windowMs / 1000) };
      }
    }
    if (!existing || existing.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (existing.count >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
    }
    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

function error(id: JsonRpcResponse["id"], code: number, message: string, status: number): ProxyResult {
  return { status, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function validRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (!keys.every((key) => ["jsonrpc", "id", "method", "params"].includes(key))) return false;
  return request.jsonrpc === "2.0"
    && (typeof request.id === "string" || typeof request.id === "number")
    && typeof request.method === "string"
    && BASE_RPC_ALLOWED_METHODS.has(request.method)
    && Array.isArray(request.params);
}

async function defaultForward(rpcUrl: string, request: JsonRpcRequest): Promise<unknown> {
  const response = await axios.post(rpcUrl, request, {
    headers: { "Content-Type": "application/json" },
    timeout: 10_000,
  });
  return response.data;
}

export async function processBaseRpcRequest(
  body: unknown,
  clientIp: string,
  options: BaseRpcProxyOptions,
): Promise<ProxyResult> {
  const serializedBody = JSON.stringify(body);
  if (typeof serializedBody === "string" && Buffer.byteLength(serializedBody) > BASE_RPC_MAX_BODY_BYTES) {
    return error(null, -32600, "JSON-RPC request too large", 413);
  }
  if (!validRequest(body)) return error(null, -32600, "Invalid JSON-RPC request", 400);

  const rate = (options.rateLimiter || new BaseRpcRateLimiter()).consume(clientIp);
  if (!rate.allowed) {
    return { ...error(body.id, -32005, "Base RPC rate limited", 429), retryAfterSeconds: rate.retryAfterSeconds };
  }

  const rpcUrl = options.getRpcUrl();
  if (!rpcUrl) return error(body.id, -32000, "Base RPC unavailable", 503);

  try {
    const upstream = await (options.forward || defaultForward)(rpcUrl, body);
    if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) {
      return error(body.id, -32000, "Base RPC request failed", 502);
    }
    const response = upstream as Record<string, unknown>;
    if (Object.hasOwn(response, "error")) {
      const upstreamError = response.error as { code?: unknown } | undefined;
      return error(body.id, typeof upstreamError?.code === "number" ? upstreamError.code : -32000, "Base RPC request failed", 200);
    }
    if (!Object.hasOwn(response, "result")) return error(body.id, -32000, "Base RPC request failed", 502);
    return { status: 200, body: { jsonrpc: "2.0", id: body.id, result: response.result } };
  } catch (upstreamError) {
    const status = axios.isAxiosError(upstreamError) && upstreamError.response?.status === 429 ? 429 : 502;
    return error(body.id, status === 429 ? -32005 : -32000, status === 429 ? "Base RPC rate limited" : "Base RPC unavailable", status);
  }
}

export function mountBaseRpcProxy(app: Express, options: BaseRpcProxyOptions): void {
  const rateLimiter = options.rateLimiter || new BaseRpcRateLimiter();
  const parser = express.json({ limit: BASE_RPC_MAX_BODY_BYTES, strict: true });
  app.post(BASE_RPC_PROXY_PATH, (req: Request, res: Response, next) => {
    parser(req, res, async (parseError) => {
      if (parseError) {
        const status = (parseError as { status?: number }).status === 413 ? 413 : 400;
        return res.status(status).json(error(null, -32600, status === 413 ? "JSON-RPC request too large" : "Invalid JSON-RPC request", status).body);
      }
      try {
        const result = await processBaseRpcRequest(req.body, req.ip || req.socket.remoteAddress || "unknown", { ...options, rateLimiter });
        if (result.retryAfterSeconds) res.setHeader("Retry-After", String(result.retryAfterSeconds));
        return res.status(result.status).json(result.body);
      } catch (routeError) {
        return next(routeError);
      }
    });
  });
}
