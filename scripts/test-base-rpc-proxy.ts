import assert from "node:assert/strict";
import express from "express";
import { BaseRpcRateLimiter, BASE_RPC_MAX_BODY_BYTES, BASE_RPC_PROXY_PATH, mountBaseRpcProxy } from "../server/baseRpcProxy";

async function startProxy(limit = 240) {
  const app = express();
  const calls: Array<{ url: string; request: unknown }> = [];
  mountBaseRpcProxy(app, {
    getRpcUrl: () => "https://base-mainnet.g.alchemy.com/v2/server-only-key",
    rateLimiter: new BaseRpcRateLimiter(limit),
    forward: async (url, request) => {
      calls.push({ url, request });
      if (request.method === "eth_call" && (request.params[0] as { data?: string })?.data === "0xdead") {
        return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "https://rpc.example/secret payload" } };
      }
      return { jsonrpc: "2.0", id: request.id, result: request.method === "eth_chainId" ? "0x2105" : "0x" };
    },
  });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, calls, url: `http://127.0.0.1:${address.port}${BASE_RPC_PROXY_PATH}` };
}

async function request(url: string, method: string, body?: unknown) {
  return fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const chainIdRequest = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
const ethCallRequest = { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: "0xca11bde05977b3631167028862be2a173976ca11", data: "0x" }, "latest"] };

const proxy = await startProxy();
try {
  let response = await request(proxy.url, "POST", chainIdRequest);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result, "0x2105");

  response = await request(proxy.url, "POST", ethCallRequest);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result, "0x");
  assert.equal(proxy.calls.length, 2);

  response = await request(proxy.url, "POST", { ...chainIdRequest, upstreamUrl: "https://attacker.example" });
  assert.equal(response.status, 400, "request-supplied upstream URL must be rejected");
  assert.equal(proxy.calls.length, 2);

  response = await request(proxy.url, "POST", [chainIdRequest]);
  assert.equal(response.status, 400, "JSON-RPC batches are intentionally unsupported");

  response = await request(proxy.url, "POST", { ...chainIdRequest, jsonrpc: "1.0" });
  assert.equal(response.status, 400, "malformed JSON-RPC requests must be rejected");

  response = await fetch(proxy.url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "not JSON" });
  assert.equal(response.status, 400, "non-JSON requests must be rejected");

  response = await request(proxy.url, "POST", { ...chainIdRequest, method: "eth_sendRawTransaction" });
  assert.equal(response.status, 400, "transaction methods must be rejected");

  response = await request(proxy.url, "GET");
  assert.equal(response.status, 404, "non-POST requests must be rejected");

  response = await request(proxy.url, "POST", { ...chainIdRequest, params: ["x".repeat(BASE_RPC_MAX_BODY_BYTES + 1024)] });
  assert.equal(response.status, 413, "oversized JSON-RPC bodies must be rejected");

  response = await request(proxy.url, "POST", { ...ethCallRequest, params: [{ data: "0xdead" }, "latest"] });
  const upstreamError = await response.json();
  assert.equal(response.status, 200);
  assert.equal(upstreamError.error.message, "Base RPC request failed");
  assert.doesNotMatch(JSON.stringify(upstreamError), /secret|rpc\.example/i);
} finally {
  await new Promise<void>((resolve, reject) => proxy.server.close((error) => error ? reject(error) : resolve()));
}

const normalWorkload = await startProxy();
try {
  for (let index = 0; index < 40; index += 1) {
    const response = await request(normalWorkload.url, "POST", { ...chainIdRequest, id: index });
    assert.equal(response.status, 200, "normal scanner-sized workloads must not be rate limited");
  }
} finally {
  await new Promise<void>((resolve, reject) => normalWorkload.server.close((error) => error ? reject(error) : resolve()));
}

const limitedProxy = await startProxy(2);
try {
  assert.equal((await request(limitedProxy.url, "POST", chainIdRequest)).status, 200);
  assert.equal((await request(limitedProxy.url, "POST", { ...chainIdRequest, id: 3 })).status, 200);
  assert.equal((await request(limitedProxy.url, "POST", { ...chainIdRequest, id: 4 })).status, 429);
} finally {
  await new Promise<void>((resolve, reject) => limitedProxy.server.close((error) => error ? reject(error) : resolve()));
}

console.log("base RPC proxy tests passed");
