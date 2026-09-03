import type Database from "better-sqlite3";
import { deriveAchievementState, type AchievementEvent } from "../src/achievements/achievementEngine.js";
import { emptyAchievementState, type AchievementState } from "../src/achievements/achievementState.js";

type AchievementRow = {
  kind: "dust_cleanup" | "bridge_complete";
  source_chain_id: number | null;
  destination_chain_id: number | null;
  cleaned_token_count: number;
  cleaned_token_addresses_json: string;
  clean_value_usd: number;
  bridge_volume_usd: number;
};

export function initializeAchievementTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS achievement_events (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('dust_cleanup', 'bridge_complete')),
      source TEXT NOT NULL CHECK (source IN ('base_rpc', 'lifi_status')),
      tx_hash TEXT NOT NULL,
      source_chain_id INTEGER,
      destination_chain_id INTEGER,
      cleaned_token_count INTEGER NOT NULL DEFAULT 0,
      cleaned_token_addresses_json TEXT NOT NULL DEFAULT '[]',
      clean_value_usd REAL NOT NULL DEFAULT 0,
      bridge_volume_usd REAL NOT NULL DEFAULT 0,
      completed_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS achievement_events_kind_tx_hash_unique ON achievement_events(kind, tx_hash);
    CREATE INDEX IF NOT EXISTS achievement_events_wallet_created_at ON achievement_events(wallet_address, created_at);
  `);
}

function parseTokenAddresses(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function getAchievementState(db: Database.Database, walletAddress: string): AchievementState {
  const rows = db.prepare(`SELECT kind, source_chain_id, destination_chain_id, cleaned_token_count, cleaned_token_addresses_json, clean_value_usd, bridge_volume_usd FROM achievement_events WHERE lower(wallet_address) = lower(?) ORDER BY completed_at, created_at, id`).all(walletAddress) as AchievementRow[];
  if (rows.length === 0) return emptyAchievementState();
  const events: AchievementEvent[] = rows.map((row) => row.kind === "dust_cleanup"
    ? { type: "dust-cleanup", tokenCount: row.cleaned_token_count, tokenAddresses: parseTokenAddresses(row.cleaned_token_addresses_json), valueUsd: row.clean_value_usd }
    : { type: "bridge-complete", fromChainId: row.source_chain_id || 0, toChainId: row.destination_chain_id || 0, volumeUsd: row.bridge_volume_usd });
  return deriveAchievementState(events);
}
