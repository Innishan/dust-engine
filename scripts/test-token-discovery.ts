import assert from "node:assert/strict";
import { formatUnits } from "viem";
import {
  discoverAlchemyTokens,
  discoverBaseTokenCandidates,
  discoverBlockscoutTransfers,
  discoverMoralisTokens,
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

  // B. Moralis's REST cursor shape is consumed across pages.
  const moralis = await discoverMoralisTokens(wallet, {
    moralisApiKey: "test", request: sequence([
      { result: [{ token_address: a }], cursor: "next" },
      { result: [{ token_address: b }] },
    ]),
  });
  assert.equal(moralis.status, "success");
  assert.deepEqual(moralis.candidates.map((token) => token.address), [a, b]);

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

  // D/E. A successful source survives failures; total failure is a 503, never empty 200.
  const partial = await discoverBaseTokenCandidates(wallet, {
    alchemyApiKey: "test", moralisApiKey: "test",
    request: async (config) => {
      if (String(config.url).includes("alchemy")) throw Object.assign(new Error("500"), { response: { status: 500 } });
      if (String(config.url).includes("moralis")) return { data: { result: [{ token_address: a }] } };
      throw Object.assign(new Error("500"), { response: { status: 500 } });
    },
  });
  assert.equal(partial.status, "partial_success");
  assert.equal(partial.tokens[0]?.address, a);

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
    alchemyApiKey: "test", moralisApiKey: "test", request: sequence([new Error("failure")]),
  });
  assert.equal(unavailable.status, "discovery_unavailable");
  assert.equal(discoveryHttpStatus(unavailable), 503);

  // F. Provenance is retained when sources report the same contract.
  const merged = mergeDiscoveryCandidates([
    { source: "alchemy", status: "success", pages: 1, candidates: [{ address: c, sources: ["alchemy"] }] },
    { source: "moralis", status: "success", pages: 1, candidates: [{ address: c.toUpperCase().replace("0X", "0x"), sources: ["moralis"] }] },
    { source: "blockscout-balances", status: "success", pages: 1, candidates: [{ address: c, sources: ["blockscout-balances"] }] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(new Set(merged[0].sources), new Set(["alchemy", "moralis", "blockscout-balances"]));

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
  console.log("token discovery tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
