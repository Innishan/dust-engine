import Database from "better-sqlite3";
import { calculateEarlySupporterBonuses, EARLY_SUPPORTER_CAMPAIGN_ID, type EarlySupporterParticipant } from "../server/earlySupporterBonus";

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

function main() {
  if (process.argv.length > 2) throw new Error("This report supports no command-line flags and is DRY-RUN ONLY.");
  console.log(`DRY RUN ONLY — no database writes are being performed. Campaign: ${EARLY_SUPPORTER_CAMPAIGN_ID}`);
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

    console.log("Wallet | Ambassador profile created_at | Earliness score | Deterministic random score | Combined score | Proposed bonus | Existing verified points | Projected total points");
    for (const row of reportRows) {
      console.log(`${row.walletAddress} | ${row.createdAt} | ${row.earlinessScore.toFixed(6)} | ${row.deterministicRandomScore.toFixed(6)} | ${row.combinedScore.toFixed(6)} | ${row.bonusPoints} | ${row.existingVerifiedPoints} | ${row.projectedTotalPoints}`);
    }
    const bonusValues = reportRows.map((row) => row.bonusPoints);
    const totalBonus = bonusValues.reduce((sum, bonus) => sum + bonus, 0);
    const averageBonus = bonusValues.length ? totalBonus / bonusValues.length : 0;
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
