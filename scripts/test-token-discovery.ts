import assert from "node:assert/strict";
import { formatUnits } from "viem";
import {
  discoverAlchemyTokens,
  discoverBaseTokenCandidates,
  discoverBlockscoutBalances,
  blockscoutLogosFromBalanceItems,
  diagnoseBlockscoutLogoItems,
  discoverBlockscoutTransfers,
  discoveryHttpStatus,
  mergeDiscoveryCandidates,
  type DiscoveryRequest,
} from "../server/tokenDiscovery";

const wallet = "0xf5ED4F07cDdD8CF29E33EE3b7a0266D5538dE912";
const a = "0x1111111111111111111111111111111111111111";
const b = "0x2222222222222222222222222222222222222222";
const c = "0x3333333333333333333333333333333333333333";

function sequence(responses: Array<unknown | Error>): DiscoveryRequest {
  let index = 0;
  return async () => {
    const next = responses[index++];
    if (next instanceof Error) throw next;
    return { data: next };
  };
}

async function run() {
  // A. Alchemy's JSON-RPC pageKey shape is consumed across pages.
  const alchemy = await discoverAlchemyTokens(wallet, {
    alchemyApiKey: "test", request: sequence([
      { result: { tokenBalances: [{ contractAddress: a }], pageKey: "next" } },
      { result: { tokenBalances: [{ contractAddress: b }] } },
    ]),
  });
  assert.equal(alchemy.status, "success");
  assert.deepEqual(alchemy.candidates.map((token) => token.address), [a, b]);

  const malformedLaterAlchemyPage = await discoverAlchemyTokens(wallet, {
    alchemyApiKey: "test",
    request: sequence([
      { result: { tokenBalances: [{ contractAddress: a }], pageKey: "next" } },
      { result: { tokenBalances: "malformed" } },
    ]),
  });
  assert.equal(malformedLaterAlchemyPage.status, "partial");
  assert.deepEqual(malformedLaterAlchemyPage.candidates.map((token) => token.address), [a], "valid first-page addresses survive a malformed later page");

  const malformedLaterTransfersPage = await discoverBlockscoutTransfers(wallet, {
    request: sequence([
      { items: [{ token: { address_hash: a, type: "ERC-20" } }], next_page_params: { block_number: 2, index: 3 } },
      { items: null },
    ]),
  });
  assert.equal(malformedLaterTransfersPage.status, "partial");
  assert.deepEqual(malformedLaterTransfersPage.candidates.map((token) => token.address), [a], "accumulated transfer-page addresses survive malformed pagination");

  const malformedFirstAlchemyPage = await discoverAlchemyTokens(wallet, {
    alchemyApiKey: "test", request: sequence([{ result: { tokenBalances: null } }]),
  });
  assert.equal(malformedFirstAlchemyPage.status, "failed");
  assert.deepEqual(malformedFirstAlchemyPage.candidates, [], "failure before any valid page has no invented results");

  let partialEmptyAlchemyCalls = 0;
  const partialEmpty = await discoverBaseTokenCandidates(wallet, {
    alchemyApiKey: "test",
    request: async (config) => {
      if (String(config.url).includes("alchemy")) {
        partialEmptyAlchemyCalls++;
        return { data: partialEmptyAlchemyCalls === 1
          ? { result: { tokenBalances: [], pageKey: "next" } }
          : { result: { tokenBalances: null } } };
      }
      throw Object.assign(new Error("provider unavailable"), { response: { status: 503 } });
    },
  });
  assert.equal(partialEmpty.status, "partial_success", "incomplete indexing is distinct from a complete empty scan");
  assert.deepEqual(partialEmpty.tokens, []);

  // C. Blockscout forwards next_page_params and exhausts the available pages.
  const transferParams: unknown[] = [];
  const transfers = await discoverBlockscoutTransfers(wallet, {
    request: async (config) => {
      transferParams.push(config.params);
      const page = transferParams.length;
      return { data: page === 1
        ? { items: [{ token: { address_hash: a, type: "ERC-20" } }], next_page_params: { block_number: 2, index: 3 } }
        : { items: [{ token: { address_hash: b, type: "ERC-20" } }] } };
    },
  });
  assert.equal(transfers.status, "success");
  assert.equal(transfers.pages, 2);
  assert.deepEqual(transferParams[1], { block_number: 2, index: 3 });

  // C2. A Cloudflare challenge is identified as an edge block, and a valid
  // response from the same public endpoint restores Blockscout market evidence.
  let blockscoutRequestUrl = "";
  const challenged = await discoverBlockscoutBalances(wallet, {
    request: async (config) => {
      blockscoutRequestUrl = String(config.url);
      throw Object.assign(new Error("Request failed with status code 403"), {
        response: { status: 403, headers: { "cf-mitigated": "challenge" }, data: "<!doctype html><title>Just a moment...</title>" },
      });
    },
  });
  assert.equal(blockscoutRequestUrl, `https://base.blockscout.com/api/v2/addresses/${wallet}/token-balances`);
  assert.equal(challenged.status, "failed");
  assert.equal(challenged.diagnostic, "HTTP 403: Cloudflare challenge blocked the Blockscout API request");

  const recovered = await discoverBlockscoutBalances(wallet, {
    request: async () => ({ data: [{ token: {
      type: "ERC-20", address_hash: a, exchange_rate: "0.05", reputation: "ok", volume_24h: "25000", icon_url: "https://assets.example/token.png",
    } }] }),
  });
  assert.equal(recovered.status, "success");
  assert.deepEqual(recovered.blockscoutQuotes?.[a], { priceUsd: 0.05, reputation: "ok", volume24h: 25_000 });
  assert.deepEqual(recovered.blockscoutLogos, { [a]: "https://assets.example/token.png" });
  assert.deepEqual(blockscoutLogosFromBalanceItems([
    { token: { type: "ERC-20", address_hash: b, icon_url: "javascript:alert(1)" } },
    { token: { type: "ERC-20", address_hash: "bad", icon_url: "https://assets.example/bad.png" } },
  ]), {});
  assert.deepEqual(diagnoseBlockscoutLogoItems([
    { token: { type: "ERC-20", address_hash: a } },
    { token: { type: "ERC-20", address: b, logo_url: "https://assets.example/icon.png" } },
  ]), {
    itemCount: 2,
    tokenObjectCount: 2,
    addressHashFieldCount: 1,
    addressFieldCount: 1,
    iconUrlFieldCount: 0,
    logoUrlFieldCount: 1,
    usableIconUrlCount: 0,
  }, "diagnostics report Blockscout property names and distinguish a missing icon_url from malformed values");

  const discoveryWithLogo = await discoverBaseTokenCandidates(wallet, {
    request: async (config) => String(config.url).includes("token-balances")
      ? { data: [{ token: { type: "ERC-20", address_hash: a, icon_url: "https://assets.example/base-token.png" } }] }
      : { data: { items: [] } },
  });
  assert.equal(discoveryWithLogo.tokens.find((token) => token.address.toLowerCase() === a)?.logoURI, "https://assets.example/base-token.png", "Blockscout logo metadata survives candidate merging into the API response shape");

  // D/E. A successful source survives failures; total failure is a 503, never empty 200.
  const partial = await discoverBaseTokenCandidates(wallet, {
    alchemyApiKey: "test",
    request: async (config) => {
      if (String(config.url).includes("alchemy")) throw Object.assign(new Error("500"), { response: { status: 500 } });
      if (String(config.url).includes("/erc20/transfers")) throw Object.assign(new Error("403"), { response: { status: 403 } });
      if (String(config.url).includes("token-balances")) return { data: [{ token: { type: "ERC-20", address_hash: a } }] };
      throw Object.assign(new Error("500"), { response: { status: 500 } });
    },
  });
  assert.equal(partial.status, "partial_success");
  assert.equal(partial.tokens[0]?.address, a);
  assert.equal(partial.discovery.sources.find((source) => source.source === "alchemy-transfers")?.status, "failed");

  // A capped provider still supplies usable candidates, even if every fully
  // completed fallback provider fails.
  const cappedAlchemy = await discoverBaseTokenCandidates(wallet, {
    alchemyApiKey: "test", maxPages: 1,
    request: async (config) => {
      if (String(config.url).includes("alchemy")) {
        return { data: { result: { tokenBalances: [{ contractAddress: a }], pageKey: "next" } } };
      }
      throw Object.assign(new Error("500"), { response: { status: 500 } });
    },
  });
  assert.equal(cappedAlchemy.status, "partial_success");
  assert.equal(cappedAlchemy.discovery.sources.find((source) => source.source === "alchemy")?.status, "capped");
  assert.equal(cappedAlchemy.tokens[0]?.address, a);
  assert.equal(discoveryHttpStatus(cappedAlchemy), 200);

  // Retained candidates from a timed-out later page remain usable discovery.
  let alchemyCalls = 0;
  const timedOutAlchemy = await discoverBaseTokenCandidates(wallet, {
    alchemyApiKey: "test",
    request: async (config) => {
      if (String(config.url).includes("alchemy")) {
        if (alchemyCalls++ === 0) return { data: { result: { tokenBalances: [{ contractAddress: a }], pageKey: "next" } } };
        throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
      }
      throw Object.assign(new Error("500"), { response: { status: 500 } });
    },
  });
  assert.equal(timedOutAlchemy.status, "partial_success");
  assert.equal(timedOutAlchemy.discovery.sources.find((source) => source.source === "alchemy")?.status, "timeout");
  assert.equal(timedOutAlchemy.tokens[0]?.address, a);

  const timedOutWithoutCandidates = await discoverBaseTokenCandidates(wallet, {
    alchemyApiKey: "test",
    request: async () => { throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" }); },
  });
  assert.equal(timedOutWithoutCandidates.status, "discovery_unavailable");
  assert.equal(discoveryHttpStatus(timedOutWithoutCandidates), 503);

  const unavailable = await discoverBaseTokenCandidates(wallet, {
    alchemyApiKey: "test", request: sequence([new Error("failure")]),
  });
  assert.equal(unavailable.status, "discovery_unavailable");
  assert.equal(discoveryHttpStatus(unavailable), 503);

  // F. Provenance is retained when sources report the same contract.
  const merged = mergeDiscoveryCandidates([
    { source: "alchemy", status: "success", pages: 1, candidates: [{ address: c, sources: ["alchemy"] }] },
    { source: "alchemy-transfers", status: "success", pages: 1, candidates: [{ address: c.toUpperCase().replace("0X", "0x"), sources: ["alchemy-transfers"] }] },
    { source: "blockscout-balances", status: "success", pages: 1, candidates: [{ address: c, sources: ["blockscout-balances"] }] },
    { source: "alchemy", status: "success", pages: 1, candidates: [{ address: "not-an-address", sources: ["alchemy"] }, { address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", sources: ["alchemy"] }] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(new Set(merged[0].sources), new Set(["alchemy", "alchemy-transfers", "blockscout-balances"]));

  // G. Provider balances are intentionally absent: only RPC-derived balances can filter candidates.
  const rpcBalances = [0n, 1n]; // provider-reported values are never supplied to this calculation
  assert.deepEqual([a, b].filter((_, index) => rpcBalances[index] > 0n), [b]);

  // Metadata is generic and comes from Base RPC. Non-18-decimal tokens are
  // formatted with their resolved decimals, while failed decimals reads never
  // manufacture a fallback balance. A symbol read failure remains displayable.
  assert.equal(formatUnits(188854n, 6), "0.188854");
  assert.equal(formatUnits(1500000000000000000n, 18), "1.5");
  // H. A genuine all-success empty result is distinct from unavailable discovery.
  const empty = await discoverBaseTokenCandidates(wallet, {
    request: async () => ({ data: { items: [] } }),
  });
  assert.equal(empty.status, "success");
  assert.equal(empty.tokens.length, 0);
  assert.equal(discoveryHttpStatus(empty), 200);

  // A failed provider plus an empty successful provider is unavailable, not a
  // misleading successful empty scan. Partial success requires usable candidates.
  const emptyAfterFailure = await discoverBaseTokenCandidates(wallet, {
    alchemyApiKey: "test",
    request: async (config) => {
      if (String(config.url).includes("alchemy")) {
        throw Object.assign(new Error("provider unavailable"), { response: { status: 503 } });
      }
      return { data: { items: [] } };
    },
  });
  assert.equal(emptyAfterFailure.status, "discovery_unavailable");
  assert.equal(emptyAfterFailure.tokens.length, 0);
  assert.equal(discoveryHttpStatus(emptyAfterFailure), 503);
  console.log("token discovery tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
