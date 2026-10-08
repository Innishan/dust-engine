import Database from "better-sqlite3";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyEarlySupporterAwardSnapshot,
  calculateEarlySupporterBonuses,
  EARLY_SUPPORTER_CAMPAIGN,
  EARLY_SUPPORTER_CAMPAIGN_ID,
  type EarlySupporterAwardSnapshot,
  type EarlySupporterParticipant,
} from "../server/earlySupporterBonus";

type AmbassadorRow = { id: string; walletAddress: string; createdAt: string };
type ActivityRow = {
  ambassadorId: string;
  kind: string;
  quantity: number;
  bridgeVolumeUsd: number;
  xQualityScore: number;
  xImpressions: number;
  completedAt: string;
};

function resolveDatabasePath() {
  const databasePath = process.env.DUST_ENGINE_DATABASE_PATH;
  if (!databasePath?.trim()) throw new Error("DUST_ENGINE_DATABASE_PATH is required");
  return databasePath;
}

function calculateExistingPoints(events: ActivityRow[]) {
  let referrals = 0;
  let coinsSwept = 0;
  let bridgeVolumeUsd = 0;
  let xPoints = 0;
  for (const event of events) {
    if (event.kind === "referral_qualified") referrals += 1;
    if (event.kind === "clean_completed") coinsSwept += Math.max(0, Number(event.quantity) || 0);
    if (event.kind === "bridge_completed") bridgeVolumeUsd += Math.max(0, Number(event.bridgeVolumeUsd) || 0);
    if (event.kind === "x_content") {
      const quality = Math.min(100, Math.max(0, Number(event.xQualityScore) || 0));
      const impressions = Math.max(0, Math.floor(Number(event.xImpressions) || 0));
      xPoints += 100 + (Math.round(quality) * 2) + Math.floor(impressions / 100);
    }
  }
  return (coinsSwept * 1) + (bridgeVolumeUsd * 1) + (referrals * 500) + xPoints;
}

function parseOptions(args: string[]) {
  if (args.length === 0) return { mode: "report" as const, json: false };
  if (args.length === 1 && args[0] === "--json") return { mode: "report" as const, json: true };
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--award-snapshot", "--confirm-campaign", "--confirm-database-path"].includes(flag)) {
      throw new Error(`Unsupported award option: ${flag}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--") || options.has(flag)) throw new Error(`Expected one value for ${flag}`);
    options.set(flag, value);
    index += 1;
  }
  if (options.size !== 3) {
    throw new Error("Awarding requires --award-snapshot, --confirm-campaign, and --confirm-database-path; default execution is dry-run only");
  }
  return {
    mode: "award" as const,
    snapshotPath: options.get("--award-snapshot")!,
    campaignId: options.get("--confirm-campaign")!,
    confirmedDatabasePath: options.get("--confirm-database-path")!,
  };
}

function loadSnapshot(snapshotPath: string): EarlySupporterAwardSnapshot {
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as EarlySupporterAwardSnapshot;
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.awards)) throw new Error("Award snapshot is not valid JSON for this campaign");
  return snapshot;
}

function awardFromSnapshot(snapshotPath: string, campaignId: string, confirmedDatabasePath: string) {
  if (campaignId !== EARLY_SUPPORTER_CAMPAIGN_ID) throw new Error(`Campaign confirmation must be ${EARLY_SUPPORTER_CAMPAIGN_ID}`);
  if (!confirmedDatabasePath.trim()) throw new Error("A database path confirmation is required");
  const configuredPath = resolveDatabasePath();
  let configuredRealPath: string;
  let confirmedRealPath: string;
  try {
    configuredRealPath = realpathSync(configuredPath);
    confirmedRealPath = realpathSync(confirmedDatabasePath);
  } catch {
    throw new Error("The configured and confirmed database paths must both resolve to the existing target database");
  }
  if (configuredRealPath !== confirmedRealPath) throw new Error("DUST_ENGINE_DATABASE_PATH does not match --confirm-database-path");

  const snapshot = loadSnapshot(snapshotPath);
  const database = new Database(configuredRealPath, { fileMustExist: true });
  try {
    const result = applyEarlySupporterAwardSnapshot(database, snapshot);
    console.log(JSON.stringify({
      status: "awarded",
      campaignId: EARLY_SUPPORTER_CAMPAIGN_ID,
      approvedAmbassadorCount: result.awardCount,
      awardsWritten: result.insertedCount,
      totalBonusPoints: result.totalBonusPoints,
      databasePath: configuredRealPath,
    }));
  } finally {
    database.close();
  }
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.mode === "award") {
    awardFromSnapshot(options.snapshotPath, options.campaignId, options.confirmedDatabasePath);
    return;
  }

  const database = new Database(resolveDatabasePath(), { readonly: true, fileMustExist: true });
  try {
    const ambassadors = database.prepare(`
      SELECT id, wallet_address AS walletAddress, created_at AS createdAt
      FROM ambassadors
      WHERE status = 'approved'
      ORDER BY lower(wallet_address)
    `).all() as AmbassadorRow[];
    const activityEvents = database.prepare(`
      SELECT ambassador_id AS ambassadorId, kind, quantity,
        bridge_volume_usd AS bridgeVolumeUsd, x_quality_score AS xQualityScore,
        x_impressions AS xImpressions, completed_at AS completedAt
      FROM ambassador_activity_events
      WHERE review_status = 'approved'
    `).all() as ActivityRow[];
    const activityByAmbassador = new Map<string, ActivityRow[]>();
    for (const event of activityEvents) {
      activityByAmbassador.set(event.ambassadorId, [...(activityByAmbassador.get(event.ambassadorId) || []), event]);
    }

    const participants: EarlySupporterParticipant[] = ambassadors.map((ambassador) => ({
      walletAddress: ambassador.walletAddress,
      createdAt: ambassador.createdAt,
      activity: (activityByAmbassador.get(ambassador.id) || []).map((event) => ({ completedAt: event.completedAt })),
    }));
    const bonuses = calculateEarlySupporterBonuses(participants);
    const byWallet = new Map(bonuses.map((bonus) => [bonus.walletAddress, bonus]));
    const reportRows = ambassadors.map((ambassador) => {
      const activity = activityByAmbassador.get(ambassador.id) || [];
      const bonus = byWallet.get(ambassador.walletAddress.toLowerCase());
      if (!bonus) throw new Error(`Missing bonus report for ${ambassador.walletAddress}`);
      const existingVerifiedPoints = calculateExistingPoints(activity);
      return {
        ...bonus,
        existingVerifiedPoints: Math.round(existingVerifiedPoints),
        projectedTotalPoints: Math.round(existingVerifiedPoints + bonus.bonusPoints),
      };
    });
    const bonusValues = reportRows.map((row) => row.bonusPoints);
    const totalBonus = bonusValues.reduce((sum, bonus) => sum + bonus, 0);
    const averageBonus = bonusValues.length ? totalBonus / bonusValues.length : 0;
    if (options.json) {
      const snapshot: EarlySupporterAwardSnapshot = {
        campaignId: EARLY_SUPPORTER_CAMPAIGN_ID,
        campaignWindow: { startAt: EARLY_SUPPORTER_CAMPAIGN.startAt, endAt: EARLY_SUPPORTER_CAMPAIGN.endAt },
        approvedAmbassadorCount: reportRows.length,
        totalBonusPoints: totalBonus,
        awards: reportRows.map(({ walletAddress, createdAt, bonusPoints }) => ({ walletAddress, createdAt, bonusPoints })),
      };
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    console.log(`DRY RUN ONLY — no database writes are being performed. Campaign: ${EARLY_SUPPORTER_CAMPAIGN_ID}`);
    console.log("Wallet | Ambassador profile created_at | Earliness score | Deterministic random score | Combined score | Proposed bonus | Existing verified points | Projected total points");
    for (const row of reportRows) {
      console.log(`${row.walletAddress} | ${row.createdAt} | ${row.earlinessScore.toFixed(6)} | ${row.deterministicRandomScore.toFixed(6)} | ${row.combinedScore.toFixed(6)} | ${row.bonusPoints} | ${row.existingVerifiedPoints} | ${row.projectedTotalPoints}`);
    }
    console.log(`TOTAL USERS: ${reportRows.length}`);
    console.log(`MIN BONUS: ${bonusValues.length ? Math.min(...bonusValues) : 0}`);
    console.log(`MAX BONUS: ${bonusValues.length ? Math.max(...bonusValues) : 0}`);
    console.log(`AVERAGE BONUS: ${averageBonus.toFixed(2)}`);
    console.log(`TOTAL BONUS POINTS: ${totalBonus}`);
    const bonusCounts = new Map<number, number>();
    for (const bonus of bonusValues) bonusCounts.set(bonus, (bonusCounts.get(bonus) || 0) + 1);
    console.log("BONUS VALUE COUNTS:");
    for (const [bonus, count] of [...bonusCounts].sort(([a], [b]) => a - b)) console.log(`${bonus}: ${count}`);
  } finally {
    database.close();
  }
}

main();
