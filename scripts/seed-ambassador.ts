import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isAddress } from "viem";

type Options = {
  id?: string;
  name?: string;
  wallet?: string;
  referralCode?: string;
  xHandle?: string;
  farcasterHandle?: string;
  help?: boolean;
};
type ArgumentOption = Exclude<keyof Options, "help">;

const usage = `
Usage:
  npm run ambassador:seed -- \\
    --id <ambassador-id> \\
    --name <display-name> \\
    --wallet <evm-address> \\
    --referral-code <code> \\
    [--x-handle <handle>] \\
    [--farcaster-handle <handle>]

Creates one approved Ambassador Program Season 1 profile in the same SQLite
database used by server.ts. It never overwrites an existing ambassador.
`.trim();

function parseArgs(args: string[]): Options {
  const optionMap: Record<string, ArgumentOption> = {
    "--id": "id",
    "--name": "name",
    "--wallet": "wallet",
    "--referral-code": "referralCode",
    "--x-handle": "xHandle",
    "--farcaster-handle": "farcasterHandle",
  };
  const options: Options = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    const key = optionMap[argument];
    if (!key || typeof args[index + 1] === "undefined" || args[index + 1].startsWith("--")) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    if (typeof options[key] !== "undefined") throw new Error(`Argument supplied more than once: ${argument}`);
    options[key] = args[index + 1];
    index += 1;
  }

  return options;
}

function required(value: string | undefined, label: string, maxLength = 256) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer`);
  return normalized;
}

function optional(value: string | undefined, label: string, maxLength = 256) {
  if (typeof value === "undefined") return null;
  return required(value, label, maxLength);
}

function addColumnIfMissing(database: Database.Database, table: string, column: string, definition: string) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((entry) => entry.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function initializeAmbassadorTable(database: Database.Database) {
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS ambassadors (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      x_handle TEXT,
      farcaster_handle TEXT,
      wallet_address TEXT UNIQUE NOT NULL,
      referral_code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('approved', 'inactive', 'revoked')),
      created_at TEXT NOT NULL,
      activated_at TEXT,
      x_user_id TEXT UNIQUE,
      x_username TEXT,
      x_display_name TEXT,
      x_verified_at TEXT
    );
  `);
  // Match the server's additive Ambassador identity migrations without altering data.
  addColumnIfMissing(database, "ambassadors", "x_handle", "x_handle TEXT");
  addColumnIfMissing(database, "ambassadors", "farcaster_handle", "farcaster_handle TEXT");
  addColumnIfMissing(database, "ambassadors", "activated_at", "activated_at TEXT");
  addColumnIfMissing(database, "ambassadors", "x_user_id", "x_user_id TEXT");
  addColumnIfMissing(database, "ambassadors", "x_username", "x_username TEXT");
  addColumnIfMissing(database, "ambassadors", "x_display_name", "x_display_name TEXT");
  addColumnIfMissing(database, "ambassadors", "x_verified_at", "x_verified_at TEXT");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS ambassadors_x_user_id_unique ON ambassadors(x_user_id) WHERE x_user_id IS NOT NULL;");
}

function main() {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid arguments");
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(usage);
    return;
  }

  try {
    const id = required(options.id, "Ambassador ID", 128);
    const displayName = required(options.name, "Display name", 256);
    const walletAddress = required(options.wallet, "Wallet address", 128).toLowerCase();
    const referralCode = required(options.referralCode, "Referral code", 128).toUpperCase();
    const xHandle = optional(options.xHandle, "X handle", 128);
    const farcasterHandle = optional(options.farcasterHandle, "Farcaster handle", 128);

    if (!isAddress(walletAddress)) throw new Error("Wallet address must be a valid EVM address");

    const __filename = fileURLToPath(import.meta.url);
    const repositoryRoot = path.resolve(path.dirname(__filename), "..");
    const databasePath = fs.existsSync("/data")
      ? "/data/dust-engine.sqlite"
      : path.join(repositoryRoot, "dust-engine.sqlite");
    const database = new Database(databasePath);

    try {
      initializeAmbassadorTable(database);
      const duplicate = database.prepare(`
        SELECT id, wallet_address, referral_code FROM ambassadors
        WHERE id = ? OR lower(wallet_address) = lower(?) OR lower(referral_code) = lower(?)
        LIMIT 1
      `).get(id, walletAddress, referralCode) as { id: string; wallet_address: string; referral_code: string } | undefined;
      if (duplicate) {
        if (duplicate.id === id) throw new Error("Ambassador ID already exists");
        if (duplicate.wallet_address.toLowerCase() === walletAddress) throw new Error("Wallet address already belongs to an ambassador");
        throw new Error("Referral code already exists");
      }

      database.prepare(`
        INSERT INTO ambassadors (id, display_name, x_handle, farcaster_handle, wallet_address, referral_code, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)
      `).run(id, displayName, xHandle, farcasterHandle, walletAddress, referralCode, new Date().toISOString());
    } finally {
      database.close();
    }

    console.log(`Approved ambassador created: ${id} (${walletAddress})`);
  } catch (error) {
    console.error(`Ambassador seed failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  }
}

main();
