import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { DUST_ENGINE_ABI, DUST_ENGINE_ADDRESS } from "../src/contracts/dustEngine.js";
import { BASE_CHAIN_ID, persistVerifiedCleanDustAmbassadorActivity, verifyCleanDustAchievementTransaction, verifyCleanDustTransaction } from "../server/ambassadorCleanVerifier.js";

const hash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const partialHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const nonAmbassadorHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const;
const revertedHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as const;
const wrongContractHash = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;
const wrongChainHash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as const;
const sender = "0x1111111111111111111111111111111111111111";
const blockNumber = 100n;

function debugLog(success: boolean, tokenAddress = "0x2222222222222222222222222222222222222222") {
  return {
    address: DUST_ENGINE_ADDRESS,
    topics: encodeEventTopics({ abi: DUST_ENGINE_ABI, eventName: "Debug" }) as `0x${string}`[],
    data: encodeAbiParameters([{ type: "address" }, { type: "bool" }], [tokenAddress as `0x${string}`, success]),
  };
}

function client({ status = "success", to = DUST_ENGINE_ADDRESS, logs = [debugLog(true)], from = sender, head = 102n, chainId = BASE_CHAIN_ID } = {}) {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => head,
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
    getTransaction: async () => ({ from, to }),
    getTransactionReceipt: async () => ({ status, blockNumber, logs }),
  };
}

async function verify(overrides = {}, approved = true) {
  return verifyCleanDustTransaction({
    txHash: hash,
    client: client(overrides),
    minimumConfirmations: 3,
    findApprovedAmbassadorId: (wallet) => approved && wallet === sender.toLowerCase() ? "ambassador-1" : undefined,
  });
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE ambassadors (id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE ambassador_activity_events (
    id TEXT PRIMARY KEY,
    ambassador_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    review_status TEXT NOT NULL,
    completed_at TEXT NOT NULL
  );
  INSERT INTO ambassadors (id, wallet_address, status) VALUES ('ambassador-1', '${sender.toLowerCase()}', 'approved');
`);

function persistActivity(activity: {
  id: string;
  ambassadorId: string;
  kind: "clean_completed";
  quantity: number;
  completedAt: string;
  reviewStatus: "approved";
}) {
  if (!db.prepare("SELECT 1 FROM ambassadors WHERE id = ? AND status = 'approved'").get(activity.ambassadorId)) {
    return { status: 400, payload: { error: "Ambassador is not approved" } };
  }
  const result = db.prepare(`INSERT OR IGNORE INTO ambassador_activity_events (id, ambassador_id, kind, quantity, review_status, completed_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(activity.id, activity.ambassadorId, activity.kind, activity.quantity, activity.reviewStatus, activity.completedAt);
  return { status: 200, payload: result.changes ? { success: true } : { success: true, duplicate: "duplicate-event" } };
}

function recordIfVerified(
  verification: Awaited<ReturnType<typeof verifyCleanDustAchievementTransaction>>,
) {
  if (!verification.ok) return "not_verified" as const;
  return persistVerifiedCleanDustAmbassadorActivity(verification, {
    findApprovedAmbassadorId: (walletAddress) => {
      const row = db.prepare("SELECT id FROM ambassadors WHERE lower(wallet_address) = lower(?) AND status = 'approved'").get(walletAddress) as { id: string } | undefined;
      return row?.id;
    },
    persistActivity,
  });
}

const valid = await verify();
assert.equal(valid.ok, true);
if (valid.ok) {
  assert.equal(valid.quantity, 1);
  assert.equal(valid.eventId, `clean:${BASE_CHAIN_ID}:${hash}`);
  assert.equal(valid.ambassadorId, "ambassador-1");
}
assert.equal((await verify({ status: "reverted" })).ok, false, "failed transaction must not award");
assert.equal((await verify({ to: "0x3333333333333333333333333333333333333333" })).ok, false, "wrong destination must not award");
assert.equal((await verify({}, false)).ok, false, "unknown wallet must not award");
assert.equal((await verify({ logs: [debugLog(false)] })).ok, false, "zero successful Debug events must not award");
const repeated = await verify();
assert.equal(repeated.ok, true);
if (repeated.ok) assert.equal(repeated.eventId, valid.ok ? valid.eventId : "", "same hash must produce the same idempotency key");

const threeSuccessful = await verifyCleanDustAchievementTransaction({
  txHash: hash,
  client: client({ logs: [debugLog(true), debugLog(true, "0x3333333333333333333333333333333333333333"), debugLog(true, "0x4444444444444444444444444444444444444444")] }),
  minimumConfirmations: 3,
});
assert.equal(threeSuccessful.ok, true);
if (threeSuccessful.ok) {
  assert.equal(threeSuccessful.quantity, 3);
  assert.equal(recordIfVerified(threeSuccessful), "persisted", "approved Ambassador gets verified clean activity");
  const activity = db.prepare("SELECT id, ambassador_id, kind, quantity, review_status FROM ambassador_activity_events WHERE id = ?").get(threeSuccessful.eventId) as { id: string; ambassador_id: string; kind: string; quantity: number; review_status: string };
  assert.deepEqual(activity, {
    id: `clean:${BASE_CHAIN_ID}:${hash}`,
    ambassador_id: "ambassador-1",
    kind: "clean_completed",
    quantity: 3,
    review_status: "approved",
  });
  const points = db.prepare("SELECT SUM(quantity) AS points FROM ambassador_activity_events WHERE ambassador_id = ? AND kind = 'clean_completed' AND review_status = 'approved'").get("ambassador-1") as { points: number };
  assert.equal(points.points * 1, 3, "leaderboard derives three Clean Dust points at one point per successful token");
  assert.equal(recordIfVerified(threeSuccessful), "duplicate", "repeated verification is idempotent");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ambassador_activity_events WHERE id = ?").get(threeSuccessful.eventId).count, 1);
}

const partialSuccess = await verifyCleanDustAchievementTransaction({
  txHash: partialHash,
  client: client({ logs: [debugLog(true), debugLog(false, "0x3333333333333333333333333333333333333333"), debugLog(true, "0x4444444444444444444444444444444444444444")] }),
  minimumConfirmations: 3,
});
assert.equal(partialSuccess.ok, true);
if (partialSuccess.ok) {
  assert.equal(partialSuccess.quantity, 2, "failed token events do not count");
  assert.equal(recordIfVerified(partialSuccess), "persisted");
}

const nonAmbassador = await verifyCleanDustAchievementTransaction({ txHash: nonAmbassadorHash, client: client({ from: "0x9999999999999999999999999999999999999999" }), minimumConfirmations: 3 });
assert.equal(nonAmbassador.ok, true);
if (nonAmbassador.ok) assert.equal(recordIfVerified(nonAmbassador), "not_ambassador");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ambassador_activity_events WHERE id = ?").get(`clean:${BASE_CHAIN_ID}:${nonAmbassadorHash}`).count, 0);

for (const [txHash, overrides, label] of [
  [revertedHash, { status: "reverted" }, "failed transaction"],
  [wrongContractHash, { to: "0x3333333333333333333333333333333333333333" }, "wrong contract"],
  [wrongChainHash, { chainId: 1 }, "wrong chain"],
] as const) {
  const verification = await verifyCleanDustAchievementTransaction({ txHash, client: client(overrides), minimumConfirmations: 3 });
  assert.equal(verification.ok, false, `${label} must fail authoritative verification`);
  assert.equal(recordIfVerified(verification), "not_verified", `${label} must not create Ambassador activity`);
}
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ambassador_activity_events").get().count, 2, "only verified Ambassador clean transactions were persisted");
db.close();
console.log("Ambassador Clean verifier tests passed");
