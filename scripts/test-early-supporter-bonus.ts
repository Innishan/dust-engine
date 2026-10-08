import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import Database from "better-sqlite3";
import {
  EARLY_SUPPORTER_CAMPAIGN,
  applyEarlySupporterAwardSnapshot,
  calculateEarlySupporterBonuses,
  type EarlySupporterAwardSnapshot,
  getDeterministicRandomScore,
  getTotalEarlySupporterBonus,
  initializeEarlySupporterAwardTable,
  recordEarlySupporterAward,
} from "../server/earlySupporterBonus";

const wallet = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const uppercaseWallet = `0x${wallet.slice(2).toUpperCase()}`;
const schemaWallet = "0x3333333333333333333333333333333333333333";
const campaignWindow = { startAt: "2025-01-01T00:00:00.000Z", endAt: "2026-01-01T00:00:00.000Z" };

function assertBonusHelperBehavior() {
  const hashVectorWallet = "0xf5ed4f07cddd8cf29e33ee3b7a0266d5538de912";
  const approvedHashInput = `early_supporter_v1:${hashVectorWallet}`;
  assert.equal(approvedHashInput, "early_supporter_v1:0xf5ed4f07cddd8cf29e33ee3b7a0266d5538de912");
  assert.equal(createHash("sha256").update(approvedHashInput).digest("hex"), "2bde0478c1c76bbbdcad29a6a274b98e16be740bfae4ca43fe824963774723c4");
  assert.equal(getDeterministicRandomScore("early_supporter_v1", hashVectorWallet), Number.parseInt("2bde0478c1c76", 16) / 0xfffffffffffff, "approved campaign and canonical wallet use the approved SHA-256 input");
  const db = new Database(":memory:");
  try {
    initializeEarlySupporterAwardTable(db);
    const insertDirect = db.prepare("INSERT INTO early_supporter_awards (campaign_id, wallet_address, bonus_points, awarded_at) VALUES (?, ?, ?, ?)");
    insertDirect.run("schema-valid", schemaWallet, 100, "2026-10-01T00:00:00.000Z");
    for (const [index, whitespace] of ["", "   ", "\t", "\n"].entries()) {
      const testWallet = `0x${String(index + 9).padStart(40, "0")}`;
      assert.throws(() => insertDirect.run(whitespace, testWallet, 150, "2026-10-01T00:00:00.000Z"), /constraint/i, `SQLite rejects campaign_id value ${JSON.stringify(whitespace)}`);
      assert.throws(() => insertDirect.run(`awarded-at-${index}`, testWallet, 150, whitespace), /constraint/i, `SQLite rejects awarded_at value ${JSON.stringify(whitespace)}`);
    }
    assert.throws(() => insertDirect.run("fractional", schemaWallet, 100.5, "2026-10-01T00:00:00.000Z"), /constraint/i, "SQLite rejects REAL bonus_points");
    assert.throws(() => insertDirect.run("whitespace", ` ${wallet} `, 150, "2026-10-01T00:00:00.000Z"), /constraint/i, "SQLite rejects whitespace-padded wallet keys");
    assert.throws(() => insertDirect.run("uppercase", uppercaseWallet, 150, "2026-10-01T00:00:00.000Z"), /constraint/i, "SQLite rejects uppercase wallet keys");

    assert.equal(getTotalEarlySupporterBonus(db, wallet), 0);
    assert.equal(recordEarlySupporterAward(db, { campaignId: "early_supporter_v1", walletAddress: wallet, bonusPoints: 200, awardedAt: "2026-10-01T00:00:00.000Z" }), true);
    assert.equal(getTotalEarlySupporterBonus(db, wallet), 200);
    assert.equal(getTotalEarlySupporterBonus(db, uppercaseWallet), 200, "wallet casing resolves to the canonical row");
    assert.equal(recordEarlySupporterAward(db, { campaignId: "early_supporter_v1", walletAddress: uppercaseWallet, bonusPoints: 900, awardedAt: "2026-10-02T00:00:00.000Z" }), false, "repeated campaign-wallet award is ignored");
    assert.equal(getTotalEarlySupporterBonus(db, wallet), 200, "duplicate award cannot replace or double the first bonus");
    assert.equal(recordEarlySupporterAward(db, { campaignId: "early_supporter_v2", walletAddress: uppercaseWallet, bonusPoints: 300, awardedAt: "2026-10-03T00:00:00.000Z" }), true, "a separate campaign has a separate record");
    assert.equal(getTotalEarlySupporterBonus(db, wallet), 500, "campaign awards sum without overwriting each other");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM early_supporter_awards WHERE wallet_address = ?").get(wallet) as { count: number }).count, 2);
  } finally {
    db.close();
  }

  assert.deepEqual(calculateEarlySupporterBonuses([]), [], "configured campaign dates allow an empty bonus calculation");
  assert.throws(() => calculateEarlySupporterBonuses([], { startAt: "not-a-timestamp", endAt: campaignWindow.endAt }), /startAt is invalid/);
  assert.throws(() => calculateEarlySupporterBonuses([], { startAt: "2025-02-31T00:00:00.000Z", endAt: campaignWindow.endAt }), /startAt is invalid/);
  assert.throws(() => calculateEarlySupporterBonuses([], { startAt: campaignWindow.endAt, endAt: campaignWindow.startAt }), /endAt must be after startAt/);
  assert.equal(EARLY_SUPPORTER_CAMPAIGN.startAt, "2026-09-01T00:00:00.000Z");
  assert.equal(EARLY_SUPPORTER_CAMPAIGN.endAt, "2026-10-06T23:59:59.999Z");

  const makeParticipant = (address: string, createdAt: string, activity: Array<{ completedAt: string }> = []) => ({ walletAddress: address, createdAt, activity });
  const zeroActivity = makeParticipant(wallet, "2024-12-31T00:00:00.000Z");
  const zeroActivityBonus = calculateEarlySupporterBonuses([zeroActivity], campaignWindow)[0];
  assert.equal(zeroActivityBonus.createdAt, zeroActivity.createdAt, "profile creation time is retained as the signal");
  assert.ok(zeroActivityBonus.bonusPoints >= 100 && zeroActivityBonus.bonusPoints <= 1000, "zero-activity wallets are eligible");
  assert.equal(zeroActivityBonus.earlinessScore, 1);
  assert.ok(!("participationSource" in zeroActivityBonus), "profile creation is not relabeled as verified first activity or wallet age");

  const beforeStart = calculateEarlySupporterBonuses([makeParticipant(wallet, "2024-12-31T00:00:00.000Z")], campaignWindow)[0];
  const atStart = calculateEarlySupporterBonuses([makeParticipant(wallet, campaignWindow.startAt)], campaignWindow)[0];
  const atEnd = calculateEarlySupporterBonuses([makeParticipant(wallet, campaignWindow.endAt)], campaignWindow)[0];
  const afterEnd = calculateEarlySupporterBonuses([makeParticipant(wallet, "2026-01-02T00:00:00.000Z")], campaignWindow)[0];
  assert.equal(beforeStart.earlinessScore, 1, "profile created before start clamps E to 1");
  assert.equal(atStart.earlinessScore, 1);
  assert.equal(atEnd.earlinessScore, 0);
  assert.equal(afterEnd.earlinessScore, 0, "profile created after end clamps E to 0");
  assert.equal(atStart.deterministicRandomScore, atEnd.deterministicRandomScore, "registration time changes only the earliness component");
  assert.ok(atStart.combinedScore > atEnd.combinedScore);

  const wallets = Array.from({ length: 12 }, (_, index) => makeParticipant(`0x${(index + 1).toString(16).padStart(40, "0")}`, "2025-06-01T00:00:00.000Z"));
  const walletBonuses = calculateEarlySupporterBonuses(wallets, campaignWindow);
  assert.ok(walletBonuses.every((row) => row.bonusPoints >= 100 && row.bonusPoints <= 1000));
  assert.ok(new Set(walletBonuses.map((row) => row.bonusPoints)).size > 1, "different wallets normally receive varied bonuses");
  assert.deepEqual(calculateEarlySupporterBonuses([zeroActivity], campaignWindow)[0], zeroActivityBonus, "same wallet input is exactly reproducible");
  assert.notEqual(getDeterministicRandomScore("early_supporter_v1", wallet), getDeterministicRandomScore("early_supporter_v2", wallet), "campaign ID participates in the allocation");

  const anotherWallet = makeParticipant("0x2222222222222222222222222222222222222222", "2025-12-01T00:00:00.000Z");
  assert.equal(calculateEarlySupporterBonuses([zeroActivity, anotherWallet], campaignWindow)[0].bonusPoints, zeroActivityBonus.bonusPoints);
  assert.equal(calculateEarlySupporterBonuses([zeroActivity, makeParticipant(anotherWallet.walletAddress, "2025-02-01T00:00:00.000Z")], campaignWindow)[0].bonusPoints, zeroActivityBonus.bonusPoints, "another wallet's data cannot change this wallet's bonus");
  const moreActivity = makeParticipant(wallet, zeroActivity.createdAt, Array.from({ length: 75 }, (_, index) => ({ completedAt: `2025-05-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` })));
  assert.equal(calculateEarlySupporterBonuses([moreActivity], campaignWindow)[0].bonusPoints, zeroActivityBonus.bonusPoints, "activity count does not affect the bonus");
  const withBridgeVolume = Object.assign(makeParticipant(wallet, zeroActivity.createdAt), { bridgeVolumeUsd: 123456 });
  assert.equal(calculateEarlySupporterBonuses([withBridgeVolume], campaignWindow)[0].bonusPoints, zeroActivityBonus.bonusPoints, "bridge volume does not affect the bonus");
  const withExistingPoints = Object.assign(makeParticipant(wallet, zeroActivity.createdAt), { existingVerifiedPoints: 987654 });
  assert.equal(calculateEarlySupporterBonuses([withExistingPoints], campaignWindow)[0].bonusPoints, zeroActivityBonus.bonusPoints, "existing verified points do not affect the bonus");
}

function makeReviewedSnapshot(): EarlySupporterAwardSnapshot {
  const points = [148, 148, ...Array.from({ length: 20 }, () => 493), 497];
  const createdAt = "2026-09-01T00:00:00.000Z";
  return {
    campaignId: "early_supporter_v1",
    campaignWindow: { startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-10-06T23:59:59.999Z" },
    approvedAmbassadorCount: 23,
    totalBonusPoints: 10_653,
    awards: points.map((bonusPoints, index) => ({
      walletAddress: `0x${(index + 1).toString(16).padStart(40, "0")}`,
      createdAt,
      bonusPoints,
    })),
  };
}

function createSnapshotDatabase(snapshot: EarlySupporterAwardSnapshot) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE ambassadors (wallet_address TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL)");
  const insertAmbassador = db.prepare("INSERT INTO ambassadors (wallet_address, created_at, status) VALUES (?, ?, 'approved')");
  for (const award of snapshot.awards) insertAmbassador.run(award.walletAddress, award.createdAt);
  return db;
}

function assertAwardSnapshotBehavior() {
  const snapshot = makeReviewedSnapshot();
  assert.equal(snapshot.awards.length, 23);
  assert.equal(snapshot.awards.filter((award) => award.bonusPoints === 148).length, 2);

  const db = createSnapshotDatabase(snapshot);
  try {
    db.exec("CREATE TABLE ambassador_activity_events (kind TEXT, bridge_volume_usd REAL)");
    db.prepare("INSERT INTO ambassador_activity_events (kind, bridge_volume_usd) VALUES ('bridge_completed', 25.5)").run();
    const result = applyEarlySupporterAwardSnapshot(db, snapshot);
    assert.deepEqual(result, { insertedCount: 23, awardCount: 23, totalBonusPoints: 10_653 });
    assert.equal(applyEarlySupporterAwardSnapshot(db, snapshot).insertedCount, 0, "reapplying the reviewed snapshot is idempotent");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM early_supporter_awards WHERE campaign_id = 'early_supporter_v1'").get() as { count: number }).count, 23);
    assert.equal((db.prepare("SELECT SUM(bonus_points) AS total FROM early_supporter_awards WHERE campaign_id = 'early_supporter_v1'").get() as { total: number }).total, 10_653);
    assert.equal((db.prepare("SELECT SUM(bridge_volume_usd) AS total FROM ambassador_activity_events").get() as { total: number }).total, 25.5, "award operation leaves activity and bridge volume untouched");
  } finally {
    db.close();
  }

  const conflictDb = createSnapshotDatabase(snapshot);
  try {
    initializeEarlySupporterAwardTable(conflictDb);
    const first = snapshot.awards[0];
    recordEarlySupporterAward(conflictDb, { campaignId: snapshot.campaignId, walletAddress: first.walletAddress, bonusPoints: first.bonusPoints === 1000 ? 999 : first.bonusPoints + 1, awardedAt: "2026-10-08T00:00:00.000Z" });
    assert.throws(() => applyEarlySupporterAwardSnapshot(conflictDb, snapshot), /conflict/i);
    assert.equal((conflictDb.prepare("SELECT COUNT(*) AS count FROM early_supporter_awards WHERE campaign_id = 'early_supporter_v1'").get() as { count: number }).count, 1, "allocation conflict aborts without partial writes");
  } finally {
    conflictDb.close();
  }

  const mismatchedDb = createSnapshotDatabase(snapshot);
  try {
    const changedSnapshot = { ...snapshot, awards: snapshot.awards.map((award, index) => index === 0 ? { ...award, createdAt: "2026-09-02T00:00:00.000Z" } : award) };
    assert.throws(() => applyEarlySupporterAwardSnapshot(mismatchedDb, changedSnapshot), /differ from the reviewed snapshot/i);
    assert.equal((mismatchedDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='early_supporter_awards'").get() as { count: number }).count, 0, "population mismatch aborts before ledger creation");
  } finally {
    mismatchedDb.close();
  }
}

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not start");
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function assertLeaderboardAndProfileCompatibility() {
  const directory = await mkdtemp(path.join(tmpdir(), "dust-engine-early-supporter-test-"));
  const databasePath = path.join(directory, "test.sqlite");
  let child: ChildProcess | undefined;
  try {
    const port = await getAvailablePort();
    child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server.ts"], {
      cwd: path.resolve("."),
      env: { ...process.env, NODE_ENV: "test", PORT: String(port), DUST_ENGINE_DATABASE_PATH: databasePath },
      stdio: "ignore",
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, child);

    const db = new Database(databasePath);
    try {
      db.prepare(`INSERT INTO ambassadors (id, display_name, wallet_address, referral_code, status, created_at, activated_at) VALUES (?, ?, ?, ?, 'approved', ?, ?)`)
        .run("amb-test", "Test Ambassador", wallet, "TESTBONUS", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
      db.prepare(`INSERT INTO ambassadors (id, display_name, wallet_address, referral_code, status, created_at, activated_at) VALUES (?, ?, ?, ?, 'approved', ?, ?)`)
        .run("amb-zero", "Zero Activity Ambassador", "0x4444444444444444444444444444444444444444", "TESTZERO", "2025-06-01T00:00:00.000Z", "2025-06-01T00:00:00.000Z");
      const insertEvent = db.prepare(`INSERT INTO ambassador_activity_events (id, ambassador_id, kind, quantity, bridge_volume_usd, x_impressions, x_quality_score, review_status, completed_at) VALUES (?, 'amb-test', ?, ?, ?, ?, ?, 'approved', ?)`);
      insertEvent.run("clean-event", "clean_completed", 3, 0, 0, 0, "2026-01-01T00:00:00.000Z");
      insertEvent.run("bridge-event", "bridge_completed", 0, 25.5, 0, 0, "2026-01-02T00:00:00.000Z");
      insertEvent.run("referral-event", "referral_qualified", 0, 0, 0, 0, "2026-01-03T00:00:00.000Z");
      insertEvent.run("x-event", "x_content", 0, 0, 250, 50, "2026-01-04T00:00:00.000Z");
      db.prepare("INSERT INTO ambassador_sessions (id, ambassador_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run("test-session", "amb-test", Date.now() + 60_000, new Date().toISOString());
    } finally {
      db.close();
    }

    const getLeaderboardEntry = async () => {
      const response = await fetch(`${baseUrl}/api/ambassadors/leaderboard`);
      assert.equal(response.status, 200);
      const body = await response.json() as { entries: Array<Record<string, unknown>>; updatedAt: string };
      const entry = body.entries.find((row) => row.walletAddress === wallet);
      assert.ok(entry, "leaderboard entry remains present");
      assert.equal(typeof body.updatedAt, "string");
      return entry;
    };

    const before = await getLeaderboardEntry();
    assert.equal(before.points, 731, "without awards the legacy verified score stays unchanged");
    assert.equal(before.earlySupporterBonus, 0);
    assert.equal(before.bridgeVolumeUsd, 25.5);
    assert.equal(before.volumeUsd, 25.5);
    assert.equal(before.coinsSwept, 3);
    assert.equal(before.referrals, 1);
    assert.equal(before.xContentPosts, 1);
    assert.equal(before.rank, 1);
    assert.equal(before.isTop50, true);

    const awardDb = new Database(databasePath);
    try {
      assert.equal(recordEarlySupporterAward(awardDb, { campaignId: "early_supporter_v1", walletAddress: wallet, bonusPoints: 200, awardedAt: "2026-10-01T00:00:00.000Z" }), true);
      assert.equal(recordEarlySupporterAward(awardDb, { campaignId: "early_supporter_v1", walletAddress: "0x4444444444444444444444444444444444444444", bonusPoints: 777, awardedAt: "2026-10-01T00:00:00.000Z" }), true);
      const zeroActivityResponse = await fetch(`${baseUrl}/api/ambassadors/leaderboard`);
      const zeroActivityBody = await zeroActivityResponse.json() as { entries: Array<Record<string, unknown>> };
      const zeroActivityEntry = zeroActivityBody.entries.find((row) => row.walletAddress === "0x4444444444444444444444444444444444444444");
      assert.ok(zeroActivityEntry, "approved leaderboard wallet with no verified activity remains eligible");
      assert.equal(zeroActivityEntry.points, 777, "zero-activity wallet receives the additive bonus");
      assert.equal(zeroActivityEntry.earlySupporterBonus, 777);
      assert.equal(zeroActivityEntry.bridgeVolumeUsd, 0);
      assert.equal(zeroActivityEntry.volumeUsd, 0);
      assert.equal(zeroActivityEntry.coinsSwept, 0);
      assert.equal(zeroActivityEntry.referrals, 0);
      assert.equal(zeroActivityEntry.xContentPosts, 0);
      const afterFirstAward = await getLeaderboardEntry();
      assert.equal(afterFirstAward.points, 931, "one award adds to the verified points");
      assert.equal(afterFirstAward.earlySupporterBonus, 200);
      assert.equal(afterFirstAward.bridgeVolumeUsd, before.bridgeVolumeUsd);
      assert.equal(afterFirstAward.volumeUsd, before.volumeUsd);
      for (const metric of ["referrals", "coinsSwept", "xContentPosts"] as const) assert.equal(afterFirstAward[metric], before[metric]);

      assert.equal(recordEarlySupporterAward(awardDb, { campaignId: "early_supporter_v1", walletAddress: uppercaseWallet, bonusPoints: 900, awardedAt: "2026-10-02T00:00:00.000Z" }), false);
      assert.equal(recordEarlySupporterAward(awardDb, { campaignId: "early_supporter_v2", walletAddress: uppercaseWallet, bonusPoints: 50 + 100, awardedAt: "2026-10-03T00:00:00.000Z" }), true);
      const afterSecondCampaign = await getLeaderboardEntry();
      assert.equal(afterSecondCampaign.points, 1081);
      assert.equal(afterSecondCampaign.earlySupporterBonus, 350);
      assert.equal(afterSecondCampaign.bridgeVolumeUsd, before.bridgeVolumeUsd);

      const profileResponse = await fetch(`${baseUrl}/api/ambassadors/profile`, { headers: { cookie: "dust_engine_ambassador_session=test-session" } });
      assert.equal(profileResponse.status, 200);
      const profileBody = await profileResponse.json() as { profile: Record<string, unknown> };
      assert.equal(profileBody.profile.points, afterSecondCampaign.points);
      assert.equal(profileBody.profile.earlySupporterBonus, afterSecondCampaign.earlySupporterBonus);
      assert.equal(profileBody.profile.bridgeVolumeUsd, before.bridgeVolumeUsd);
      assert.equal(profileBody.profile.volumeUsd, before.volumeUsd);
    } finally {
      awardDb.close();
    }
  } finally {
    if (child) await stopServer(child);
    await rm(directory, { recursive: true, force: true });
  }
}

assertBonusHelperBehavior();
assertAwardSnapshotBehavior();
await assertLeaderboardAndProfileCompatibility();
console.log("Early supporter bonus tests passed");
