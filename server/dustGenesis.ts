import crypto from "crypto";
import express, { type Request, type Response } from "express";
import Database from "better-sqlite3";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isHex,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { DUST_GENESIS_ABI } from "../src/contracts/dustGenesis.js";

export const DUST_GENESIS_CHAIN_ID = 8453;
export const DUST_GENESIS_CAMPAIGN_DURATION_SECONDS = 14 * 24 * 60 * 60;
export const DUST_GENESIS_TASK_DELAY_MS = 10_000;
export const DUST_GENESIS_AUTHORIZATION_TTL_SECONDS = 5 * 60;
export const DUST_GENESIS_PROFILE_URL = "https://x.com/dustengineapp";
const WALLET_NONCE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 24 * 60 * 60_000;
const TASK_SESSION_TTL_MS = 60 * 60_000;
const TASK_SESSION_COOKIE = "dust_genesis_task_session";
const EXISTING_DUST_ENGINE_ADDRESS = "0x8CE9D13FEb45cFd723dac5923896A96A46DD3894".toLowerCase();

type DustGenesisTask = "profile" | "announcement";
type ChainEligibility = {
  chainId(): Promise<number>;
  hasMinted(wallet: Address): Promise<boolean>;
  mintingClosed(): Promise<boolean>;
  authorizedSigner(): Promise<Address>;
  campaignStartTimestamp(): Promise<bigint>;
  campaignDeadline(): Promise<bigint>;
  chainTimestamp(): Promise<bigint>;
};

export type DustGenesisRouteConfig = {
  xAnnouncementUrl?: string;
  contractAddress?: string;
  signerPrivateKey?: string;
  chainEligibility?: ChainEligibility;
  now?: () => number;
  secureCookies?: boolean;
};

export function initializeDustGenesisTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dust_genesis_auth_nonces (
      nonce TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS dust_genesis_sessions (
      token_hash TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dust_genesis_sessions_wallet_idx
      ON dust_genesis_sessions(wallet_address, expires_at);
    CREATE TABLE IF NOT EXISTS dust_genesis_task_progress (
      wallet_address TEXT NOT NULL,
      task_key TEXT NOT NULL CHECK (task_key IN ('profile', 'announcement')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY (wallet_address, task_key)
    );
    CREATE TABLE IF NOT EXISTS dust_genesis_task_sessions (
      session_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      wallet_address TEXT
    );
    CREATE INDEX IF NOT EXISTS dust_genesis_task_sessions_expiry_idx
      ON dust_genesis_task_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS dust_genesis_anonymous_task_progress (
      session_hash TEXT NOT NULL,
      task_key TEXT NOT NULL CHECK (task_key IN ('profile', 'announcement')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY (session_hash, task_key)
    );
    CREATE TABLE IF NOT EXISTS dust_genesis_mint_authorizations (
      nonce TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dust_genesis_rate_limits (
      bucket_key TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL
    );
  `);
}

function hasOnlyKeys(body: unknown, keys: string[]) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const received = Object.keys(body as Record<string, unknown>);
  return received.length === keys.length && received.every((key) => keys.includes(key));
}

function configuredXUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const candidate = value.trim();
    // Accept a dashboard value pasted as a Markdown link, but expose only its URL.
    const markdownLink = /^\[[^\]]+\]\((https:\/\/[^\s)]+)\)$/i.exec(candidate);
    const url = new URL(markdownLink?.[1] ?? candidate);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host)) return null;
    if (url.pathname === "/" || url.pathname.length < 2) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeContractAddress(value: string | undefined): Address | undefined {
  if (!value || !isAddress(value)) return undefined;
  const address = getAddress(value);
  if (address.toLowerCase() === EXISTING_DUST_ENGINE_ADDRESS) return undefined;
  return address;
}

export function createDustGenesisRouter(db: Database.Database, config: DustGenesisRouteConfig = {}) {
  const router = express.Router();
  const now = config.now ?? Date.now;
  const profileUrl = DUST_GENESIS_PROFILE_URL;
  const announcementUrl = configuredXUrl(config.xAnnouncementUrl);
  const contractAddress = normalizeContractAddress(config.contractAddress);

  const takeRateLimit = (key: string, limit: number, windowMs = 60_000) => {
    const currentTime = now();
    return db.transaction(() => {
      db.prepare("DELETE FROM dust_genesis_rate_limits WHERE window_started_at + 60000 <= ?").run(currentTime);
      const current = db.prepare("SELECT window_started_at, request_count FROM dust_genesis_rate_limits WHERE bucket_key = ?")
        .get(key) as { window_started_at: number; request_count: number } | undefined;
      if (!current || current.window_started_at + windowMs <= currentTime) {
        db.prepare(`INSERT INTO dust_genesis_rate_limits (bucket_key, window_started_at, request_count)
          VALUES (?, ?, 1) ON CONFLICT(bucket_key) DO UPDATE SET window_started_at = excluded.window_started_at, request_count = 1`)
          .run(key, currentTime);
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (current.request_count >= limit) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.window_started_at + windowMs - currentTime) / 1000)) };
      }
      db.prepare("UPDATE dust_genesis_rate_limits SET request_count = request_count + 1 WHERE bucket_key = ?").run(key);
      return { allowed: true, retryAfterSeconds: 0 };
    })();
  };

  const enforceRateLimit = (req: Request, res: Response, scope: string, walletAddress?: string) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const limits = [takeRateLimit(`${scope}:ip:${ip}`, 30)];
    if (walletAddress) limits.push(takeRateLimit(`${scope}:wallet:${walletAddress.toLowerCase()}`, 20));
    const denied = limits.find((result) => !result.allowed);
    if (!denied) return false;
    res.setHeader("Retry-After", String(denied.retryAfterSeconds));
    res.status(429).json({ error: "Too many requests" });
    return true;
  };

  const getSession = (req: Request) => {
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(req.header("authorization") || "");
    if (!match) return undefined;
    const tokenHash = crypto.createHash("sha256").update(match[1].toLowerCase()).digest("hex");
    const session = db.prepare("SELECT wallet_address, expires_at FROM dust_genesis_sessions WHERE token_hash = ?")
      .get(tokenHash) as { wallet_address: string; expires_at: number } | undefined;
    if (!session || session.expires_at <= now()) return undefined;
    return { walletAddress: session.wallet_address as Address };
  };

  const reconcileTaskProgress = (walletAddress: string, currentTime: number) => db.transaction(() => {
    db.prepare(`UPDATE dust_genesis_task_progress SET completed_at = ?
      WHERE wallet_address = ? AND task_key = 'profile' AND completed_at IS NULL AND started_at <= ?`)
      .run(currentTime, walletAddress, currentTime - DUST_GENESIS_TASK_DELAY_MS);
    const profile = db.prepare(`SELECT completed_at FROM dust_genesis_task_progress
      WHERE wallet_address = ? AND task_key = 'profile'`).get(walletAddress) as { completed_at: number | null } | undefined;
    if (profile?.completed_at !== null && profile?.completed_at !== undefined) {
      db.prepare(`UPDATE dust_genesis_task_progress SET completed_at = NULL
        WHERE wallet_address = ? AND task_key = 'announcement' AND started_at < ?`)
        .run(walletAddress, profile.completed_at);
      db.prepare(`UPDATE dust_genesis_task_progress SET completed_at = ?
        WHERE wallet_address = ? AND task_key = 'announcement' AND completed_at IS NULL
          AND started_at >= ? AND started_at <= ?`)
        .run(currentTime, walletAddress, profile.completed_at, currentTime - DUST_GENESIS_TASK_DELAY_MS);
    } else {
      db.prepare(`UPDATE dust_genesis_task_progress SET completed_at = NULL
        WHERE wallet_address = ? AND task_key = 'announcement'`)
        .run(walletAddress);
    }
    return db.prepare(`SELECT task_key, started_at, completed_at FROM dust_genesis_task_progress WHERE wallet_address = ?`)
      .all(walletAddress) as { task_key: DustGenesisTask; started_at: number; completed_at: number | null }[];
  })();

  const readTaskSession = (req: Request) => {
    const cookies = (req.header("cookie") || "").split(";").map((part) => part.trim());
    const values = cookies.filter((part) => part.startsWith(`${TASK_SESSION_COOKIE}=`));
    if (values.length !== 1) return undefined;
    const token = values[0].slice(TASK_SESSION_COOKIE.length + 1);
    if (!/^[a-f0-9]{64}$/i.test(token)) return undefined;
    const sessionHash = crypto.createHash("sha256").update(token.toLowerCase()).digest("hex");
    const session = db.prepare(`SELECT session_hash, expires_at, wallet_address
      FROM dust_genesis_task_sessions WHERE session_hash = ?`).get(sessionHash) as {
        session_hash: string;
        expires_at: number;
        wallet_address: string | null;
      } | undefined;
    if (!session || session.expires_at <= now()) return undefined;
    return session;
  };

  const createTaskSession = (res: Response) => {
    const currentTime = now();
    const token = crypto.randomBytes(32).toString("hex");
    const sessionHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = currentTime + TASK_SESSION_TTL_MS;
    db.transaction(() => {
      db.prepare(`DELETE FROM dust_genesis_anonymous_task_progress
        WHERE session_hash IN (SELECT session_hash FROM dust_genesis_task_sessions WHERE expires_at <= ?)`)
        .run(currentTime);
      db.prepare("DELETE FROM dust_genesis_task_sessions WHERE expires_at <= ?").run(currentTime);
      db.prepare(`INSERT INTO dust_genesis_task_sessions (session_hash, created_at, expires_at, wallet_address)
        VALUES (?, ?, ?, NULL)`).run(sessionHash, currentTime, expiresAt);
    })();
    const secure = config.secureCookies ?? process.env.NODE_ENV === "production";
    const cookie = `${TASK_SESSION_COOKIE}=${token}; Path=/api/dust-genesis; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(TASK_SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
    res.setHeader("Cache-Control", "no-store");
    res.append("Set-Cookie", cookie);
    return { session_hash: sessionHash, expires_at: expiresAt, wallet_address: null };
  };

  const ensureTaskSession = (req: Request, res: Response) => readTaskSession(req) ?? createTaskSession(res);

  const requireTaskSession = (req: Request, res: Response) => {
    if (enforceRateLimit(req, res, "task-session-ip")) return undefined;
    const session = readTaskSession(req);
    if (!session) {
      res.status(401).json({ error: "Task session expired. Reload the campaign page to continue." });
      return undefined;
    }
    if (enforceRateLimit(req, res, "task-session", session.session_hash)) return undefined;
    return session;
  };

  const reconcileAnonymousTaskProgress = (sessionHash: string, currentTime: number) => db.transaction(() => {
    db.prepare(`UPDATE dust_genesis_anonymous_task_progress SET completed_at = ?
      WHERE session_hash = ? AND task_key = 'profile' AND completed_at IS NULL AND started_at <= ?`)
      .run(currentTime, sessionHash, currentTime - DUST_GENESIS_TASK_DELAY_MS);
    const profile = db.prepare(`SELECT completed_at FROM dust_genesis_anonymous_task_progress
      WHERE session_hash = ? AND task_key = 'profile'`).get(sessionHash) as { completed_at: number | null } | undefined;
    if (profile?.completed_at !== null && profile?.completed_at !== undefined) {
      db.prepare(`UPDATE dust_genesis_anonymous_task_progress SET completed_at = NULL
        WHERE session_hash = ? AND task_key = 'announcement' AND started_at < ?`)
        .run(sessionHash, profile.completed_at);
      db.prepare(`UPDATE dust_genesis_anonymous_task_progress SET completed_at = ?
        WHERE session_hash = ? AND task_key = 'announcement' AND completed_at IS NULL
          AND started_at >= ? AND started_at <= ?`)
        .run(currentTime, sessionHash, profile.completed_at, currentTime - DUST_GENESIS_TASK_DELAY_MS);
    } else {
      db.prepare(`UPDATE dust_genesis_anonymous_task_progress SET completed_at = NULL
        WHERE session_hash = ? AND task_key = 'announcement'`)
        .run(sessionHash);
    }
    return db.prepare(`SELECT task_key, started_at, completed_at
      FROM dust_genesis_anonymous_task_progress WHERE session_hash = ?`)
      .all(sessionHash) as { task_key: DustGenesisTask; started_at: number; completed_at: number | null }[];
  })();

  const taskProgressResponse = (tasks: { task_key: DustGenesisTask; started_at: number; completed_at: number | null }[]) => ({
    profileStarted: tasks.some((task) => task.task_key === "profile"),
    profileComplete: tasks.some((task) => task.task_key === "profile" && task.completed_at !== null),
    announcementStarted: tasks.some((task) => task.task_key === "announcement"),
    announcementComplete: tasks.some((task) => task.task_key === "announcement" && task.completed_at !== null),
  });

  const requireSession = (req: Request, res: Response) => {
    if (enforceRateLimit(req, res, "session-ip")) return undefined;
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ error: "Wallet authentication required" });
      return undefined;
    }
    if (enforceRateLimit(req, res, "session-wallet", session.walletAddress)) return undefined;
    return session;
  };

  router.get("/config", async (req, res) => {
    try {
      if (enforceRateLimit(req, res, "config")) return;
      const [campaignStartTimestamp, campaignDeadline, chainTimestamp] = config.chainEligibility
        ? await Promise.all([
            config.chainEligibility.campaignStartTimestamp(),
            config.chainEligibility.campaignDeadline(),
            config.chainEligibility.chainTimestamp(),
          ])
        : [0n, 0n, 0n];
      if (campaignStartTimestamp > 0n
        && campaignDeadline - campaignStartTimestamp !== BigInt(DUST_GENESIS_CAMPAIGN_DURATION_SECONDS)) {
        return res.status(503).json({ error: "Dust Genesis campaign configuration is invalid" });
      }
      ensureTaskSession(req, res);
      return res.json({
        chainId: DUST_GENESIS_CHAIN_ID,
        contractAddress: contractAddress ?? null,
        campaignStartTimestamp: Number(campaignStartTimestamp),
        campaignDeadline: Number(campaignDeadline),
        chainTimestamp: Number(chainTimestamp),
        tasks: [
          { id: "profile", label: "Follow the official Dust Engine X profile", url: profileUrl },
          { id: "announcement", label: "Like and retweet the post", url: announcementUrl },
        ],
      });
    } catch {
      return res.status(503).json({ error: "Dust Genesis campaign state could not be checked" });
    }
  });

  router.post("/auth/nonce", (req, res) => {
    if (!hasOnlyKeys(req.body, ["walletAddress"]) || typeof req.body.walletAddress !== "string" || !isAddress(req.body.walletAddress)) {
      return res.status(400).json({ error: "Invalid wallet address" });
    }
    const walletAddress = getAddress(req.body.walletAddress);
    if (enforceRateLimit(req, res, "nonce", walletAddress)) return;
    const currentTime = now();
    db.prepare("DELETE FROM dust_genesis_auth_nonces WHERE expires_at <= ? OR used_at IS NOT NULL").run(currentTime);
    db.prepare("DELETE FROM dust_genesis_sessions WHERE expires_at <= ?").run(currentTime);
    const nonce = crypto.randomBytes(24).toString("hex");
    const expiresAt = currentTime + WALLET_NONCE_TTL_MS;
    const message = [
      "Dust Genesis wallet access",
      `Domain: ${req.hostname}`,
      `Wallet: ${walletAddress.toLowerCase()}`,
      `Chain ID: ${DUST_GENESIS_CHAIN_ID}`,
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expiresAt).toISOString()}`,
    ].join("\n");
    db.prepare(`INSERT INTO dust_genesis_auth_nonces (nonce, wallet_address, message, expires_at)
      VALUES (?, ?, ?, ?)`).run(nonce, walletAddress.toLowerCase(), message, expiresAt);
    return res.json({ nonce, message });
  });

  router.post("/auth/verify", async (req, res) => {
    if (!hasOnlyKeys(req.body, ["walletAddress", "nonce", "signature"])
      || typeof req.body.walletAddress !== "string" || !isAddress(req.body.walletAddress)
      || typeof req.body.nonce !== "string" || !/^[a-f0-9]{48}$/i.test(req.body.nonce)
      || typeof req.body.signature !== "string" || !isHex(req.body.signature, { strict: true })) {
      return res.status(400).json({ error: "Invalid wallet proof" });
    }
    const walletAddress = getAddress(req.body.walletAddress);
    if (enforceRateLimit(req, res, "verify", walletAddress)) return;
    const challenge = db.prepare(`SELECT message, expires_at FROM dust_genesis_auth_nonces
      WHERE nonce = ? AND wallet_address = ? AND used_at IS NULL`)
      .get(req.body.nonce, walletAddress.toLowerCase()) as { message: string; expires_at: number } | undefined;
    if (!challenge || challenge.expires_at <= now()) return res.status(400).json({ error: "Wallet proof expired or already used" });
    let verified = false;
    try {
      verified = await verifyMessage({ address: walletAddress, message: challenge.message, signature: req.body.signature as Hex });
    } catch {
      verified = false;
    }
    if (!verified) return res.status(401).json({ error: "Invalid wallet signature" });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const currentTime = now();
    const accepted = db.transaction(() => {
      const used = db.prepare(`UPDATE dust_genesis_auth_nonces SET used_at = ?
        WHERE nonce = ? AND wallet_address = ? AND used_at IS NULL AND expires_at > ?`)
        .run(currentTime, req.body.nonce, walletAddress.toLowerCase(), currentTime);
      if (used.changes !== 1) return false;
      db.prepare(`INSERT INTO dust_genesis_sessions (token_hash, wallet_address, created_at, expires_at)
        VALUES (?, ?, ?, ?)`).run(tokenHash, walletAddress.toLowerCase(), currentTime, currentTime + SESSION_TTL_MS);
      return true;
    })();
    if (!accepted) return res.status(400).json({ error: "Wallet proof expired or already used" });
    return res.json({ accessToken: rawToken, expiresAt: currentTime + SESSION_TTL_MS });
  });

  router.post("/tasks/:task/start", (req, res) => {
    if (!hasOnlyKeys(req.body, [])) return res.status(400).json({ error: "Invalid request" });
    const task = req.params.task;
    if (task !== "profile" && task !== "announcement") return res.status(404).json({ error: "Unknown task" });
    if ((task === "profile" && !profileUrl) || (task === "announcement" && !announcementUrl)) {
      return res.status(503).json({ error: "Campaign task URL is not configured" });
    }
    const currentTime = now();
    if (req.header("authorization")) {
      const session = requireSession(req, res);
      if (!session) return;
      const walletAddress = session.walletAddress.toLowerCase();
      if (task === "announcement") {
        const progress = reconcileTaskProgress(walletAddress, currentTime);
        if (!progress.some((entry) => entry.task_key === "profile" && entry.completed_at !== null)) {
          return res.status(403).json({ error: "Complete the profile task first" });
        }
        const profile = db.prepare(`SELECT completed_at FROM dust_genesis_task_progress
          WHERE wallet_address = ? AND task_key = 'profile'`).get(walletAddress) as { completed_at: number };
        db.prepare(`UPDATE dust_genesis_task_progress SET started_at = ?, completed_at = NULL
          WHERE wallet_address = ? AND task_key = 'announcement' AND started_at < ?`)
          .run(currentTime, walletAddress, profile.completed_at);
      }
      db.prepare(`INSERT INTO dust_genesis_task_progress (wallet_address, task_key, started_at)
        VALUES (?, ?, ?) ON CONFLICT(wallet_address, task_key) DO NOTHING`)
        .run(walletAddress, task, currentTime);
      return res.json({ started: true });
    }

    const taskSession = requireTaskSession(req, res);
    if (!taskSession) return;
    if (taskSession.wallet_address) return res.status(403).json({ error: "Task session is already bound to another wallet" });
    if (task === "announcement") {
      const progress = reconcileAnonymousTaskProgress(taskSession.session_hash, currentTime);
      if (!progress.some((entry) => entry.task_key === "profile" && entry.completed_at !== null)) {
        return res.status(403).json({ error: "Complete the profile task first" });
      }
    }
    db.prepare(`INSERT INTO dust_genesis_anonymous_task_progress (session_hash, task_key, started_at)
      VALUES (?, ?, ?) ON CONFLICT(session_hash, task_key) DO NOTHING`)
      .run(taskSession.session_hash, task, currentTime);
    return res.json({ started: true });
  });

  router.post("/progress", (req, res) => {
    try {
      if (!hasOnlyKeys(req.body, [])) return res.status(400).json({ error: "Invalid request" });
      const currentTime = now();
      const hasWalletAuthorization = Boolean(req.header("authorization"));
      if (hasWalletAuthorization) {
        const walletSession = requireSession(req, res);
        if (!walletSession) return;
        const taskSession = readTaskSession(req);
        if (taskSession?.wallet_address && taskSession.wallet_address !== walletSession.walletAddress.toLowerCase()) {
          return res.status(403).json({ error: "Task session is already bound to another wallet" });
        }
        if (taskSession && !taskSession.wallet_address) {
          const anonymousProgress = reconcileAnonymousTaskProgress(taskSession.session_hash, currentTime);
          const walletProgress = reconcileTaskProgress(walletSession.walletAddress.toLowerCase(), currentTime);
          const merged = new Map<DustGenesisTask, { task_key: DustGenesisTask; started_at: number; completed_at: number | null }>();
          for (const task of [...walletProgress, ...anonymousProgress]) {
            const current = merged.get(task.task_key);
            if (!current || (task.completed_at !== null && (current.completed_at === null || task.completed_at > current.completed_at))) {
              merged.set(task.task_key, task);
            }
          }
          return res.json(taskProgressResponse([...merged.values()]));
        }
        const tasks = reconcileTaskProgress(walletSession.walletAddress.toLowerCase(), currentTime);
        return res.json(taskProgressResponse(tasks));
      }

      const taskSession = requireTaskSession(req, res);
      if (!taskSession) return;
      if (taskSession.wallet_address) {
        return res.json(taskProgressResponse(reconcileTaskProgress(taskSession.wallet_address, currentTime)));
      }
      return res.json(taskProgressResponse(reconcileAnonymousTaskProgress(taskSession.session_hash, currentTime)));
    } catch {
      return res.status(503).json({ error: "Dust Genesis task progress could not be checked" });
    }
  });

  router.post("/tasks/bind", (req, res) => {
    if (!hasOnlyKeys(req.body, [])) return res.status(400).json({ error: "Invalid request" });
    const walletSession = requireSession(req, res);
    if (!walletSession) return;
    const taskSession = requireTaskSession(req, res);
    if (!taskSession) return;
    const walletAddress = walletSession.walletAddress.toLowerCase();
    const currentTime = now();
    const anonymousProgress = reconcileAnonymousTaskProgress(taskSession.session_hash, currentTime);
    const walletProgress = reconcileTaskProgress(walletAddress, currentTime);
    const anonymousComplete = anonymousProgress.some((task) => task.task_key === "profile" && task.completed_at !== null)
      && anonymousProgress.some((task) => task.task_key === "announcement" && task.completed_at !== null);
    const walletComplete = walletProgress.some((task) => task.task_key === "profile" && task.completed_at !== null)
      && walletProgress.some((task) => task.task_key === "announcement" && task.completed_at !== null);
    if (!anonymousComplete && !walletComplete) {
      return res.status(403).json({ error: "Campaign tasks are incomplete" });
    }

    const bound = db.transaction(() => {
      const current = db.prepare(`SELECT wallet_address FROM dust_genesis_task_sessions
        WHERE session_hash = ? AND expires_at > ?`).get(taskSession.session_hash, currentTime) as { wallet_address: string | null } | undefined;
      if (!current || (current.wallet_address && current.wallet_address !== walletAddress)) return false;
      if (!current.wallet_address) {
        const updated = db.prepare(`UPDATE dust_genesis_task_sessions SET wallet_address = ?
          WHERE session_hash = ? AND wallet_address IS NULL AND expires_at > ?`)
          .run(walletAddress, taskSession.session_hash, currentTime);
        if (updated.changes !== 1) return false;
      }
      if (anonymousComplete) {
        for (const task of anonymousProgress) {
          db.prepare(`INSERT INTO dust_genesis_task_progress (wallet_address, task_key, started_at, completed_at)
            VALUES (?, ?, ?, ?) ON CONFLICT(wallet_address, task_key) DO UPDATE SET
              started_at = excluded.started_at, completed_at = excluded.completed_at`)
            .run(walletAddress, task.task_key, task.started_at, task.completed_at);
        }
      }
      return true;
    })();
    if (!bound) return res.status(403).json({ error: "Task session is already bound to another wallet" });
    return res.json({ bound: true });
  });

  router.post("/authorization", async (req, res) => {
    if (!hasOnlyKeys(req.body, [])) return res.status(400).json({ error: "Invalid request" });
    const session = requireSession(req, res);
    if (!session) return;
    const walletAddress = session.walletAddress;
    const tasks = db.prepare(`SELECT task_key, completed_at FROM dust_genesis_task_progress WHERE wallet_address = ?`)
      .all(walletAddress.toLowerCase()) as { task_key: DustGenesisTask; completed_at: number | null }[];
    if (!tasks.some((task) => task.task_key === "profile" && task.completed_at !== null)
      || !tasks.some((task) => task.task_key === "announcement" && task.completed_at !== null)) {
      return res.status(403).json({ error: "Campaign tasks are incomplete" });
    }
    if (!contractAddress || !config.signerPrivateKey || !config.chainEligibility) {
      return res.status(503).json({ error: "Dust Genesis mint authorization is not configured" });
    }

    try {
      const signerAccount = privateKeyToAccount(config.signerPrivateKey as Hex);
      const [chainId, alreadyMinted, mintingClosed, authorizedSigner, campaignStartTimestamp, campaignDeadline, chainTimestamp] = await Promise.all([
        config.chainEligibility.chainId(),
        config.chainEligibility.hasMinted(walletAddress),
        config.chainEligibility.mintingClosed(),
        config.chainEligibility.authorizedSigner(),
        config.chainEligibility.campaignStartTimestamp(),
        config.chainEligibility.campaignDeadline(),
        config.chainEligibility.chainTimestamp(),
      ]);
      if (chainId !== DUST_GENESIS_CHAIN_ID || alreadyMinted || mintingClosed
        || authorizedSigner.toLowerCase() !== signerAccount.address.toLowerCase()
        || campaignStartTimestamp === 0n
        || campaignDeadline - campaignStartTimestamp !== BigInt(DUST_GENESIS_CAMPAIGN_DURATION_SECONDS)
        || chainTimestamp < campaignStartTimestamp || chainTimestamp >= campaignDeadline) {
        return res.status(403).json({ error: "Wallet is not eligible to mint" });
      }

      const currentTime = now();
      const expiry = Math.min(
        Number(chainTimestamp) + DUST_GENESIS_AUTHORIZATION_TTL_SECONDS,
        Number(campaignDeadline),
      );
      db.prepare("DELETE FROM dust_genesis_mint_authorizations WHERE expires_at <= ?").run(currentTime);
      const nonce = `0x${crypto.randomBytes(32).toString("hex")}` as Hex;
      const signature = await signerAccount.signTypedData({
        domain: { name: "Dust Genesis", version: "1", chainId: DUST_GENESIS_CHAIN_ID, verifyingContract: contractAddress },
        types: { MintAuthorization: [
          { name: "recipient", type: "address" },
          { name: "nonce", type: "bytes32" },
          { name: "expiry", type: "uint256" },
        ] },
        primaryType: "MintAuthorization",
        message: { recipient: walletAddress, nonce, expiry: BigInt(expiry) },
      });
      db.prepare(`INSERT INTO dust_genesis_mint_authorizations (nonce, wallet_address, issued_at, expires_at)
        VALUES (?, ?, ?, ?)`).run(nonce.toLowerCase(), walletAddress.toLowerCase(), currentTime, expiry * 1000);
      return res.json({ contractAddress, recipient: walletAddress, nonce, expiry, signature });
    } catch {
      return res.status(503).json({ error: "Dust Genesis eligibility could not be checked" });
    }
  });

  return router;
}

export function createDustGenesisChainEligibility(contractAddress: Address, rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org"): ChainEligibility {
  const client: any = createPublicClient({ chain: base, transport: http(rpcUrl) });
  return {
    chainId() {
      return client.getChainId();
    },
    async hasMinted(wallet) {
      return client.readContract({ address: contractAddress, abi: DUST_GENESIS_ABI, functionName: "hasMinted", args: [wallet] });
    },
    async mintingClosed() {
      return client.readContract({
        address: contractAddress,
        abi: [{ type: "function", name: "mintingClosed", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }],
        functionName: "mintingClosed",
      });
    },
    async authorizedSigner() {
      return client.readContract({
        address: contractAddress,
        abi: [{ type: "function", name: "authorizedSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
        functionName: "authorizedSigner",
      });
    },
    async campaignStartTimestamp() {
      return client.readContract({
        address: contractAddress,
        abi: [{ type: "function", name: "campaignStartTimestamp", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "campaignStartTimestamp",
      });
    },
    async campaignDeadline() {
      return client.readContract({
        address: contractAddress,
        abi: [{ type: "function", name: "campaignDeadline", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "campaignDeadline",
      });
    },
    async chainTimestamp() {
      const block = await client.getBlock();
      return block.timestamp;
    },
  };
}
