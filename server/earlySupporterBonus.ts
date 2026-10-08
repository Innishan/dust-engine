import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { isAddress } from "viem";

export const EARLY_SUPPORTER_CAMPAIGN = {
  id: "early_supporter_v1",
  // Approved campaign window.
  startAt: "2026-09-01T00:00:00.000Z",
  endAt: "2026-10-06T23:59:59.999Z",
} as const;
export const EARLY_SUPPORTER_CAMPAIGN_ID = EARLY_SUPPORTER_CAMPAIGN.id;

export type EarlySupporterCampaignWindow = { startAt: string; endAt: string };

export type EarlySupporterActivity = { completedAt: string };

export type EarlySupporterParticipant = {
  walletAddress: string;
  createdAt: string;
  activity: EarlySupporterActivity[];
};

export type EarlySupporterBonusReport = {
  walletAddress: string;
  createdAt: string;
  earlinessScore: number;
  deterministicRandomScore: number;
  combinedScore: number;
  bonusPoints: number;
};

export function initializeEarlySupporterAwardTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS early_supporter_awards (
      campaign_id TEXT NOT NULL CHECK (length(trim(campaign_id, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) > 0),
      wallet_address TEXT NOT NULL CHECK (wallet_address = lower(wallet_address) AND wallet_address = trim(wallet_address)),
      bonus_points INTEGER NOT NULL CHECK (typeof(bonus_points) = 'integer' AND bonus_points BETWEEN 100 AND 1000),
      awarded_at TEXT NOT NULL CHECK (length(trim(awarded_at, char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) > 0),
      PRIMARY KEY (campaign_id, wallet_address)
    );
  `);
}

export function canonicalizeWalletAddress(walletAddress: string) {
  const normalized = walletAddress.trim().toLowerCase();
  if (!isAddress(normalized)) throw new Error("Invalid wallet address");
  return normalized;
}

export function recordEarlySupporterAward(
  db: Database.Database,
  award: { campaignId: string; walletAddress: string; bonusPoints: number; awardedAt: string },
) {
  if (!award.campaignId.trim()) throw new Error("Campaign ID is required");
  if (!Number.isInteger(award.bonusPoints) || award.bonusPoints < 100 || award.bonusPoints > 1000) {
    throw new Error("Bonus points must be an integer between 100 and 1000");
  }
  if (!Number.isFinite(Date.parse(award.awardedAt))) throw new Error("Award timestamp is invalid");
  const result = db.prepare(`
    INSERT OR IGNORE INTO early_supporter_awards (campaign_id, wallet_address, bonus_points, awarded_at)
    VALUES (?, ?, ?, ?)
  `).run(award.campaignId, canonicalizeWalletAddress(award.walletAddress), award.bonusPoints, award.awardedAt);
  return result.changes === 1;
}

export function getTotalEarlySupporterBonus(db: Database.Database, walletAddress: string) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(bonus_points), 0) AS bonus
    FROM early_supporter_awards
    WHERE wallet_address = ?
  `).get(walletAddress.trim().toLowerCase()) as { bonus: number };
  return Number(row.bonus) || 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function getDeterministicRandomScore(campaignId: string, walletAddress: string) {
  if (!campaignId.trim()) throw new Error("Campaign ID is required");
  const canonicalWallet = canonicalizeWalletAddress(walletAddress);
  const hash = createHash("sha256").update(`${campaignId}:${canonicalWallet}`).digest("hex");
  // The first 13 hex digits fit in a precisely represented JavaScript integer.
  return Number.parseInt(hash.slice(0, 13), 16) / 0xfffffffffffff;
}

function parseCampaignWindow(window: EarlySupporterCampaignWindow) {
  const parseTimestamp = (value: string, label: "startAt" | "endAt") => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    const timestamp = Date.parse(value);
    const calendarDate = value.slice(0, 10);
    const midnight = new Date(`${calendarDate}T00:00:00.000Z`);
    const validCalendarDate = Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === calendarDate;
    const validClock = match && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59;
    if (!match || !validCalendarDate || !validClock || !Number.isFinite(timestamp)) {
      throw new Error(`Early supporter campaign ${label} is invalid or unapproved: ${value}`);
    }
    return timestamp;
  };
  const startTimestamp = parseTimestamp(window.startAt, "startAt");
  const endTimestamp = parseTimestamp(window.endAt, "endAt");
  if (endTimestamp <= startTimestamp) {
    throw new Error("Early supporter campaign endAt must be after startAt");
  }
  return { startTimestamp, endTimestamp };
}

export function calculateEarlySupporterBonuses(
  participants: EarlySupporterParticipant[],
  window: EarlySupporterCampaignWindow = EARLY_SUPPORTER_CAMPAIGN,
  campaignId = EARLY_SUPPORTER_CAMPAIGN_ID,
): EarlySupporterBonusReport[] {
  const { startTimestamp, endTimestamp } = parseCampaignWindow(window);
  const inputs = participants.map((participant) => {
    const createdTimestamp = Date.parse(participant.createdAt);
    if (!Number.isFinite(createdTimestamp)) throw new Error(`Invalid Ambassador profile creation timestamp for ${participant.walletAddress}`);
    return {
      walletAddress: canonicalizeWalletAddress(participant.walletAddress),
      createdAt: participant.createdAt,
      createdTimestamp,
    };
  });

  if (!inputs.length) return [];
  if (!campaignId.trim()) throw new Error("Campaign ID is required");

  return inputs.map((input) => {
    // created_at is Ambassador profile creation time, not wallet creation or
    // proof of verified first activity. No activity or volume fields are inputs.
    const earlinessScore = clamp((endTimestamp - input.createdTimestamp) / (endTimestamp - startTimestamp), 0, 1);
    const deterministicRandomScore = getDeterministicRandomScore(campaignId, input.walletAddress);
    const combinedScore = (0.8 * deterministicRandomScore) + (0.2 * earlinessScore);
    const bonusPoints = clamp(Math.round(100 + (900 * combinedScore)), 100, 1000);
    return {
      walletAddress: input.walletAddress,
      createdAt: input.createdAt,
      earlinessScore,
      deterministicRandomScore,
      combinedScore,
      bonusPoints,
    };
  });
}
