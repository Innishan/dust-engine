import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { DUST_ENGINE_ABI, DUST_ENGINE_ADDRESS } from "../src/contracts/dustEngine.js";
import { calculateUnlocked, deriveAchievementState } from "../src/achievements/achievementEngine.js";
import { initializeAchievementTables, getAchievementState } from "../server/achievementPersistence.js";
import { BASE_CHAIN_ID, verifyCleanDustAchievementTransaction } from "../server/ambassadorCleanVerifier.js";

const wallet = "0x1111111111111111111111111111111111111111";
const fakeWallet = "0x9999999999999999999999999999999999999999";
const cleanHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const bridgeHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const token = "0x2222222222222222222222222222222222222222";

function debugLog(tokenAddress = token) {
  return {
    address: DUST_ENGINE_ADDRESS,
    topics: encodeEventTopics({ abi: DUST_ENGINE_ABI, eventName: "Debug" }) as `0x${string}`[],
    data: encodeAbiParameters([{ type: "address" }, { type: "bool" }], [tokenAddress, true]),
  };
}

const client = {
  getChainId: async () => BASE_CHAIN_ID,
  getBlockNumber: async () => 102n,
  getBlock: async () => ({ timestamp: 1_700_000_000n }),
  getTransaction: async () => ({ from: wallet, to: DUST_ENGINE_ADDRESS }),
  getTransactionReceipt: async () => ({ status: "success", blockNumber: 100n, logs: [debugLog()] }),
};

const verifiedClean = await verifyCleanDustAchievementTransaction({ txHash: cleanHash, client, minimumConfirmations: 3 });
assert.equal(verifiedClean.ok, true, "verified Base evidence is required");
if (!verifiedClean.ok) throw new Error(verifiedClean.reason);
assert.equal(verifiedClean.walletAddress, wallet.toLowerCase(), "wallet is derived from the transaction, never request input");
assert.deepEqual(verifiedClean.tokenAddresses, [token.toLowerCase()]);

const directory = await mkdtemp(path.join(tmpdir(), "dust-engine-achievement-test-"));
const databasePath = path.join(directory, "achievements.sqlite");
try {
  const db = new Database(databasePath);
  initializeAchievementTables(db);
  assert.deepEqual(getAchievementState(db, wallet), {
    cleanupCount: 0, cleanedTokenCount: 0, uniqueTokenAddresses: [], totalCleanedUsd: 0, largestCleanupUsd: 0,
    bridgeCount: 0, totalBridgeVolumeUsd: 0, bridgeChainIds: [], unlocked: [],
  }, "a new wallet has empty server state");

  const insertClean = db.prepare(`INSERT OR IGNORE INTO achievement_events (id, wallet_address, kind, source, tx_hash, source_chain_id, cleaned_token_count, cleaned_token_addresses_json, clean_value_usd, bridge_volume_usd, completed_at, created_at) VALUES (?, ?, 'dust_cleanup', 'base_rpc', ?, 8453, ?, ?, 0, 0, ?, ?)`);
  const cleanArgs = ["achievement:clean", verifiedClean.walletAddress, cleanHash, verifiedClean.quantity, JSON.stringify(verifiedClean.tokenAddresses), verifiedClean.completedAt, verifiedClean.completedAt] as const;
  assert.equal(insertClean.run(...cleanArgs).changes, 1, "verified Clean Dust creates one event");
  assert.equal(insertClean.run(...cleanArgs).changes, 0, "duplicate Clean Dust is idempotent");
  // These browser-controlled values are intentionally absent from the insert and cannot affect state.
  const afterClean = getAchievementState(db, wallet);
  assert.equal(afterClean.cleanedTokenCount, 1);
  assert.equal(afterClean.totalCleanedUsd, 0, "unverified browser USD is never persisted");
  assert.equal(getAchievementState(db, fakeWallet).cleanupCount, 0, "browser cannot attribute an event to another wallet");

  const insertBridge = db.prepare(`INSERT OR IGNORE INTO achievement_events (id, wallet_address, kind, source, tx_hash, source_chain_id, destination_chain_id, cleaned_token_count, cleaned_token_addresses_json, clean_value_usd, bridge_volume_usd, completed_at, created_at) VALUES (?, ?, 'bridge_complete', 'lifi_status', ?, 1, 10, 0, '[]', 0, 125, ?, ?)`);
  const bridgeArgs = ["achievement:bridge", wallet, bridgeHash, verifiedClean.completedAt, verifiedClean.completedAt] as const;
  assert.equal(insertBridge.run(...bridgeArgs).changes, 1, "verified Bridge creates one event");
  assert.equal(insertBridge.run(...bridgeArgs).changes, 0, "duplicate Bridge is idempotent");
  assert.equal(getAchievementState(db, wallet).bridgeCount, 1, "non-Ambassador event state has no Ambassador dependency");
  db.close();

  const reopened = new Database(databasePath, { readonly: true });
  assert.equal(getAchievementState(reopened, wallet).bridgeCount, 1, "reopening SQLite preserves achievement state");
  reopened.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}

const thresholds = deriveAchievementState([
  { type: "dust-cleanup", tokenCount: 25, tokenAddresses: Array.from({ length: 25 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`), valueUsd: 0 },
  ...Array.from({ length: 25 }, (_, i) => ({ type: "bridge-complete" as const, fromChainId: i + 1, toChainId: i + 101, volumeUsd: 40 })),
]);
assert.deepEqual(new Set(thresholds.unlocked), new Set(["first-cleanup", "dust-cleaner", "dust-hunter", "bridge-explorer", "bridge-runner", "chain-hopper", "token-hunter", "cross-chain", "bridge-master", "bridge-legend"]), "existing thresholds remain unchanged");
assert.deepEqual(calculateUnlocked(thresholds), thresholds.unlocked);
console.log("Achievement persistence tests passed");
