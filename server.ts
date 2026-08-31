import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import cors from "cors";
import Database from "better-sqlite3";
import crypto from "crypto";
import { verifyMessage, isAddress, createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { verifyCleanDustTransaction } from "./server/ambassadorCleanVerifier";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Season 1 scoring is intentionally absolute: one ambassador's activity never
// changes another ambassador's score. Adjust campaign rates only here.
const AMBASSADOR_POINTS = {
  CLEAN_DUST_POINTS_PER_COIN: 1,
  BRIDGE_POINTS_PER_USD: 1,
  QUALIFIED_REFERRAL_POINTS: 500,
  X_CONTENT_BASE_POINTS: 100,
  X_QUALITY_POINTS_PER_SCORE: 5,
  X_IMPRESSION_LOG_MULTIPLIER: 100,
} as const;
const X_PRODUCTION_CALLBACK = "https://dustengine.xyz/api/auth/x/callback";
const AMBASSADOR_SESSION_COOKIE = "dust_engine_ambassador_session";

async function startServer() {
  const app = express();
  const configuredPort = Number.parseInt(process.env.PORT || "4000", 10);
  const PORT = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 4000;
  
  app.use(cors());
  app.use(express.json());

  // ===== API ROUTES =====
  
  // Health check
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      keys: {
        debank: !!process.env.DEBANK_API_KEY,
        oneinch: !!process.env.ONE_INCH_API_KEY
      }
    });
  });

  // Stats
  const statsDatabasePath = process.env.DUST_ENGINE_DATABASE_PATH || (fs.existsSync("/data")
    ? "/data/dust-engine.sqlite"
    : path.join(__dirname, "dust-engine.sqlite"));
  const statsDb = new Database(statsDatabasePath);
  // SQLite does not enforce declared foreign keys unless this is enabled per connection.
  statsDb.pragma("foreign_keys = ON");

  statsDb.exec(`
    CREATE TABLE IF NOT EXISTS app_stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_dust_cleaned_usd REAL NOT NULL,
      total_swaps INTEGER NOT NULL,
      users_served INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO app_stats (
      id,
      total_dust_cleaned_usd,
      total_swaps,
      users_served
    ) VALUES (1, 210, 142, 105);
  `);

  const getStats = statsDb.prepare(`
    SELECT
      total_dust_cleaned_usd AS totalDustCleanedUsd,
      total_swaps AS totalSwaps,
      users_served AS usersServed
    FROM app_stats
    WHERE id = 1
  `);
  const updateStats = statsDb.transaction((valueUsd: number) => {
    statsDb.prepare(`
      UPDATE app_stats
      SET
        total_dust_cleaned_usd = total_dust_cleaned_usd + ?,
        total_swaps = total_swaps + 1,
        users_served = users_served + 1
      WHERE id = 1
    `).run(valueUsd);
  });

  app.get("/api/stats", (req, res) => {
    res.json(getStats.get());
  });

  app.post("/api/report-swap", (req, res) => {
    const { valueUsd } = req.body;
    updateStats(valueUsd || 0);
    res.json({ success: true });
  });

  // Ambassador Program: isolated, server-authoritative campaign data.
  // Ambassador approval and qualifying activity are managed by the Dust Engine team.
  statsDb.exec(`
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
    CREATE TABLE IF NOT EXISTS ambassador_auth_nonces (
      nonce TEXT PRIMARY KEY,
      ambassador_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at TEXT,
      FOREIGN KEY (ambassador_id) REFERENCES ambassadors(id)
    );
    CREATE TABLE IF NOT EXISTS ambassador_registration_nonces (
      nonce TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ambassador_sessions (
      id TEXT PRIMARY KEY,
      ambassador_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (ambassador_id) REFERENCES ambassadors(id)
    );
    CREATE TABLE IF NOT EXISTS ambassador_oauth_states (
      state TEXT PRIMARY KEY,
      ambassador_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (ambassador_id) REFERENCES ambassadors(id)
    );
    CREATE TABLE IF NOT EXISTS referral_auth_nonces (
      nonce TEXT PRIMARY KEY,
      ambassador_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      referral_code TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at TEXT,
      FOREIGN KEY (ambassador_id) REFERENCES ambassadors(id)
    );
    CREATE TABLE IF NOT EXISTS referral_attributions (
      referred_wallet_address TEXT PRIMARY KEY,
      ambassador_id TEXT NOT NULL,
      referral_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified', 'rejected')),
      created_at TEXT NOT NULL,
      qualified_at TEXT,
      FOREIGN KEY (ambassador_id) REFERENCES ambassadors(id)
    );
    CREATE TABLE IF NOT EXISTS ambassador_activity_events (
      id TEXT PRIMARY KEY,
      ambassador_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('referral_qualified', 'clean_completed', 'bridge_completed', 'x_content')),
      quantity REAL NOT NULL DEFAULT 0,
      bridge_volume_usd REAL NOT NULL DEFAULT 0,
      x_post_content TEXT,
      x_post_url TEXT,
      x_post_id TEXT,
      x_user_id TEXT,
      x_impressions INTEGER,
      x_quality_score REAL,
      reviewer TEXT,
      review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
      completed_at TEXT NOT NULL,
      FOREIGN KEY (ambassador_id) REFERENCES ambassadors(id)
    );
  `);

  // Existing databases may predate the identity/X and scoring columns. These
  // migrations are additive only; no Ambassador data is deleted or recreated.
  const addColumnIfMissing = (table: string, column: string, definition: string) => {
    const columns = statsDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((entry) => entry.name === column)) {
      statsDb.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  };
  addColumnIfMissing("ambassadors", "x_handle", "x_handle TEXT");
  addColumnIfMissing("ambassadors", "farcaster_handle", "farcaster_handle TEXT");
  addColumnIfMissing("ambassadors", "activated_at", "activated_at TEXT");
  addColumnIfMissing("ambassadors", "x_user_id", "x_user_id TEXT");
  addColumnIfMissing("ambassadors", "x_username", "x_username TEXT");
  addColumnIfMissing("ambassadors", "x_display_name", "x_display_name TEXT");
  addColumnIfMissing("ambassadors", "x_verified_at", "x_verified_at TEXT");
  addColumnIfMissing("ambassador_oauth_states", "session_id", "session_id TEXT");
  addColumnIfMissing("ambassador_activity_events", "quantity", "quantity REAL NOT NULL DEFAULT 0");
  addColumnIfMissing("ambassador_activity_events", "bridge_volume_usd", "bridge_volume_usd REAL NOT NULL DEFAULT 0");
  addColumnIfMissing("ambassador_activity_events", "x_post_content", "x_post_content TEXT");
  addColumnIfMissing("ambassador_activity_events", "x_post_url", "x_post_url TEXT");
  addColumnIfMissing("ambassador_activity_events", "x_post_id", "x_post_id TEXT");
  addColumnIfMissing("ambassador_activity_events", "x_user_id", "x_user_id TEXT");
  addColumnIfMissing("ambassador_activity_events", "x_impressions", "x_impressions INTEGER");
  addColumnIfMissing("ambassador_activity_events", "x_quality_score", "x_quality_score REAL");
  addColumnIfMissing("ambassador_activity_events", "reviewer", "reviewer TEXT");
  addColumnIfMissing("ambassador_activity_events", "review_status", "review_status TEXT NOT NULL DEFAULT 'pending'");
  addColumnIfMissing("ambassador_activity_events", "completed_at", "completed_at TEXT");
  statsDb.prepare("UPDATE ambassador_activity_events SET completed_at = ? WHERE completed_at IS NULL").run(new Date().toISOString());
  statsDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS ambassadors_x_user_id_unique ON ambassadors(x_user_id) WHERE x_user_id IS NOT NULL;");
  // One public X post can only earn campaign points once. Existing duplicate legacy
  // rows are preserved; the endpoint-level check still prevents new duplicates.
  const duplicateXPost = statsDb.prepare(`
    SELECT x_post_id FROM ambassador_activity_events
    WHERE kind = 'x_content' AND x_post_id IS NOT NULL
    GROUP BY x_post_id HAVING COUNT(*) > 1 LIMIT 1
  `).get() as { x_post_id: string } | undefined;
  if (!duplicateXPost) {
    statsDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS ambassador_x_content_post_unique ON ambassador_activity_events(x_post_id) WHERE kind = 'x_content' AND x_post_id IS NOT NULL;");
  }

  const getApprovedAmbassadorByWallet = statsDb.prepare(`
    SELECT id, display_name AS displayName, x_handle AS xHandle, referral_code AS referralCode,
      x_user_id AS xUserId, x_username AS xUsername, x_display_name AS xDisplayName, activated_at AS activatedAt
    FROM ambassadors WHERE lower(wallet_address) = lower(?) AND status = 'approved'
  `);
  const getAmbassadorStatusByWallet = statsDb.prepare(`
    SELECT id, status FROM ambassadors WHERE lower(wallet_address) = lower(?)
  `);

  const getOAuthConfig = () => {
    const clientId = process.env.X_CLIENT_ID;
    const clientSecret = process.env.X_CLIENT_SECRET;
    const redirectUri = process.env.X_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) return null;
    try {
      const callback = new URL(redirectUri);
      const isProduction = process.env.NODE_ENV === "production";
      const isLoopbackHttp = callback.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(callback.hostname);
      if ((isProduction && redirectUri !== X_PRODUCTION_CALLBACK) || (callback.protocol !== "https:" && !isLoopbackHttp)) return null;
    } catch {
      return null;
    }
    return { clientId, clientSecret, redirectUri };
  };
  const createOpaqueToken = () => crypto.randomBytes(32).toString("base64url");
  const createPkceChallenge = (verifier: string) => crypto.createHash("sha256").update(verifier).digest("base64url");
  const oauthRedirect = (res: express.Response, result: string) => res.redirect(302, `/?section=ambassador&x=${result}`);
  const getAuthenticatedAmbassadorSession = (req: express.Request) => {
    const cookie = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${AMBASSADOR_SESSION_COOKIE}=`));
    if (!cookie) return null;
    const sessionId = decodeURIComponent(cookie.slice(AMBASSADOR_SESSION_COOKIE.length + 1));
    const ambassador = statsDb.prepare(`
      SELECT a.id, a.display_name AS displayName, a.x_handle AS xHandle, a.referral_code AS referralCode,
        a.x_user_id AS xUserId, a.x_username AS xUsername, a.x_display_name AS xDisplayName, a.activated_at AS activatedAt
      FROM ambassador_sessions s JOIN ambassadors a ON a.id = s.ambassador_id
      WHERE s.id = ? AND s.expires_at > ? AND a.status = 'approved'
    `).get(sessionId, Date.now()) as any;
    return ambassador ? { sessionId, ambassador } : null;
  };
  const getSessionAmbassador = (req: express.Request) => getAuthenticatedAmbassadorSession(req)?.ambassador || null;
  const setAmbassadorSession = (res: express.Response, ambassadorId: string) => {
    const id = createOpaqueToken();
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    statsDb.prepare(`INSERT INTO ambassador_sessions (id, ambassador_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).run(id, ambassadorId, expiresAt, new Date().toISOString());
    res.cookie(AMBASSADOR_SESSION_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000, path: "/" });
  };
  const getApprovedAmbassadorIdByWallet = statsDb.prepare(`
    SELECT id FROM ambassadors WHERE lower(wallet_address) = lower(?) AND status = 'approved'
  `);
  const createAmbassadorId = () => `amb_${crypto.randomUUID()}`;
  const createReferralCode = () => `AMB${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

  type ActivityEvent = { ambassadorId: string; kind: string; quantity: number; bridgeVolumeUsd: number; xQualityScore: number; xImpressions: number; reviewStatus: string; completedAt: string };
  const getLeaderboardEntries = () => {
    const ambassadors = statsDb.prepare(`SELECT id, display_name AS creator, x_handle AS xHandle, x_username AS xUsername, created_at AS createdAt FROM ambassadors WHERE status = 'approved'`).all() as any[];
    const events = statsDb.prepare(`SELECT ambassador_id AS ambassadorId, kind, quantity, bridge_volume_usd AS bridgeVolumeUsd, x_quality_score AS xQualityScore, x_impressions AS xImpressions, review_status AS reviewStatus, completed_at AS completedAt FROM ambassador_activity_events WHERE review_status = 'approved'`).all() as ActivityEvent[];
    const byAmbassador = new Map<string, ActivityEvent[]>();
    for (const event of events) byAmbassador.set(event.ambassadorId, [...(byAmbassador.get(event.ambassadorId) || []), event]);
    const entries = ambassadors.map((ambassador) => {
      const activity = byAmbassador.get(ambassador.id) || [];
      let referrals = 0;
      let coinsSwept = 0;
      let bridgeVolumeUsd = 0;
      let xContentPosts = 0;
      let xPoints = 0;
      for (const event of activity) {
        if (event.kind === "referral_qualified") referrals += 1;
        if (event.kind === "clean_completed") coinsSwept += Math.max(0, Number(event.quantity) || 0);
        if (event.kind === "bridge_completed") bridgeVolumeUsd += Math.max(0, Number(event.bridgeVolumeUsd) || 0);
        if (event.kind === "x_content") {
          const quality = Math.min(100, Math.max(0, Number(event.xQualityScore) || 0));
          const impressions = Math.max(0, Math.floor(Number(event.xImpressions) || 0));
          xContentPosts += 1;
          xPoints += AMBASSADOR_POINTS.X_CONTENT_BASE_POINTS + (quality * AMBASSADOR_POINTS.X_QUALITY_POINTS_PER_SCORE) + Math.floor(Math.log10(impressions + 1) * AMBASSADOR_POINTS.X_IMPRESSION_LOG_MULTIPLIER);
        }
      }
      const points = (coinsSwept * AMBASSADOR_POINTS.CLEAN_DUST_POINTS_PER_COIN) + (bridgeVolumeUsd * AMBASSADOR_POINTS.BRIDGE_POINTS_PER_USD) + (referrals * AMBASSADOR_POINTS.QUALIFIED_REFERRAL_POINTS) + xPoints;
      const firstVerifiedActivityAt = activity.map((event) => event.completedAt).sort()[0] || ambassador.createdAt;
      // Clean Dust is verified as a token count only. Never estimate its USD value
      // from client analytics; verified USD volume currently consists of Bridge only.
      const volumeUsd = bridgeVolumeUsd;
      return { ambassadorId: ambassador.id, creator: ambassador.creator, xHandle: ambassador.xUsername || ambassador.xHandle, points: Math.round(points), referrals, coinsSwept, bridgeVolumeUsd, volumeUsd, xContentPosts, firstVerifiedActivityAt };
    });
    // Stable ties: points, then bridge volume, then earliest verified activity.
    return entries.sort((a, b) => b.points - a.points || b.bridgeVolumeUsd - a.bridgeVolumeUsd || a.firstVerifiedActivityAt.localeCompare(b.firstVerifiedActivityAt) || a.ambassadorId.localeCompare(b.ambassadorId))
      .map((entry, index) => ({ ...entry, rank: index + 1, isTop50: index < 50 }));
  };

  app.get("/api/ambassadors/leaderboard", (_req, res) => {
    res.json({ entries: getLeaderboardEntries(), updatedAt: new Date().toISOString() });
  });

  app.post("/api/ambassadors/auth/nonce", (req, res) => {
    const walletAddress = String(req.body.walletAddress || "");
    if (!isAddress(walletAddress)) return res.status(400).json({ error: "Invalid wallet address" });
    const ambassador = getApprovedAmbassadorByWallet.get(walletAddress) as any;
    const existing = getAmbassadorStatusByWallet.get(walletAddress) as { id: string; status: string } | undefined;
    if (existing && existing.status !== "approved") return res.status(403).json({ error: "This ambassador profile is not eligible" });
    const nonce = crypto.randomBytes(24).toString("hex");
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const message = `Dust Engine Ambassador Activation\nWallet: ${walletAddress.toLowerCase()}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}`;
    if (ambassador) {
      statsDb.prepare(`INSERT INTO ambassador_auth_nonces (nonce, ambassador_id, wallet_address, message, expires_at) VALUES (?, ?, ?, ?, ?)`).run(nonce, ambassador.id, walletAddress.toLowerCase(), message, expiresAt);
    } else {
      statsDb.prepare(`INSERT INTO ambassador_registration_nonces (nonce, wallet_address, message, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`).run(nonce, walletAddress.toLowerCase(), message, expiresAt, new Date().toISOString());
    }
    res.json({ nonce, message });
  });

  app.post("/api/ambassadors/auth/activate", async (req, res) => {
    const { walletAddress, nonce, signature } = req.body;
    if (!isAddress(walletAddress) || typeof nonce !== "string" || typeof signature !== "string") return res.status(400).json({ error: "Invalid activation request" });
    const auth = statsDb.prepare(`SELECT * FROM ambassador_auth_nonces WHERE nonce = ? AND wallet_address = ? AND used_at IS NULL`).get(nonce, walletAddress.toLowerCase()) as any;
    const registrationAuth = auth ? null : statsDb.prepare(`SELECT * FROM ambassador_registration_nonces WHERE nonce = ? AND wallet_address = ? AND used_at IS NULL`).get(nonce, walletAddress.toLowerCase()) as any;
    const activationAuth = auth || registrationAuth;
    if (!activationAuth || activationAuth.expires_at < Date.now()) return res.status(400).json({ error: "Activation request expired" });
    const valid = await verifyMessage({ address: walletAddress, message: activationAuth.message, signature: signature as `0x${string}` });
    if (!valid) return res.status(401).json({ error: "Invalid signature" });
    const ambassador = statsDb.transaction(() => {
      const now = new Date().toISOString();
      const nonceTable = auth ? "ambassador_auth_nonces" : "ambassador_registration_nonces";
      const claimed = statsDb.prepare(`UPDATE ${nonceTable} SET used_at = ? WHERE nonce = ? AND wallet_address = ? AND used_at IS NULL AND expires_at > ?`)
        .run(now, nonce, walletAddress.toLowerCase(), Date.now());
      if (claimed.changes !== 1) return null;
      if (auth) {
        statsDb.prepare(`UPDATE ambassadors SET activated_at = ? WHERE id = ? AND status = 'approved'`).run(now, auth.ambassador_id);
      } else {
        const existing = getAmbassadorStatusByWallet.get(walletAddress) as { id: string; status: string } | undefined;
        if (existing && existing.status !== "approved") return null;
        if (!existing) {
          statsDb.prepare(`INSERT INTO ambassadors (id, display_name, wallet_address, referral_code, status, created_at, activated_at) VALUES (?, ?, ?, ?, 'approved', ?, ?)`)
            .run(createAmbassadorId(), `Ambassador ${walletAddress.slice(2, 8)}`, walletAddress.toLowerCase(), createReferralCode(), now, now);
        } else {
          statsDb.prepare(`UPDATE ambassadors SET activated_at = ? WHERE id = ?`).run(now, existing.id);
        }
      }
      return getApprovedAmbassadorByWallet.get(walletAddress) as any;
    })();
    if (!ambassador) return res.status(400).json({ error: "Activation request expired or already used" });
    setAmbassadorSession(res, ambassador.id);
    res.json({ profile: ambassador });
  });

  app.get("/api/ambassadors/profile", (req, res) => {
    const ambassador = getSessionAmbassador(req);
    if (!ambassador) return res.status(401).json({ error: "Ambassador session required" });
    const entry = getLeaderboardEntries().find((item) => item.ambassadorId === ambassador.id);
    res.json({ profile: { ...ambassador, xVerified: Boolean(ambassador.xUserId), ...(entry || { points: 0, referrals: 0, coinsSwept: 0, bridgeVolumeUsd: 0, volumeUsd: 0, xContentPosts: 0 }) } });
  });

  app.get("/api/auth/x/start", (req, res) => {
    const authenticatedSession = getAuthenticatedAmbassadorSession(req);
    const config = getOAuthConfig();
    if (!authenticatedSession || !authenticatedSession.ambassador.activatedAt) return oauthRedirect(res, "wallet-required");
    if (!config) return oauthRedirect(res, "unavailable");
    const state = createOpaqueToken();
    const codeVerifier = createOpaqueToken();
    statsDb.prepare(`INSERT INTO ambassador_oauth_states (state, ambassador_id, session_id, code_verifier, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(state, authenticatedSession.ambassador.id, authenticatedSession.sessionId, codeVerifier, Date.now() + 10 * 60 * 1000, new Date().toISOString());
    const authorizationUrl = new URL("https://x.com/i/oauth2/authorize");
    authorizationUrl.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: "users.read", state, code_challenge: createPkceChallenge(codeVerifier), code_challenge_method: "S256" }).toString();
    res.redirect(302, authorizationUrl.toString());
  });

  app.get("/api/auth/x/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";
    if (!state || state.length > 256) return oauthRedirect(res, "invalid-state");
    const oauthState = statsDb.prepare(`SELECT * FROM ambassador_oauth_states WHERE state = ? AND used_at IS NULL AND expires_at > ?`).get(state, Date.now()) as any;
    if (!oauthState) return oauthRedirect(res, "invalid-state");
    const authenticatedSession = getAuthenticatedAmbassadorSession(req);
    if (!authenticatedSession || authenticatedSession.sessionId !== oauthState.session_id || authenticatedSession.ambassador.id !== oauthState.ambassador_id) {
      return oauthRedirect(res, "invalid-state");
    }
    const claimed = statsDb.prepare(`UPDATE ambassador_oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL AND expires_at > ?`).run(new Date().toISOString(), state, Date.now());
    if (claimed.changes !== 1) return oauthRedirect(res, "invalid-state");
    if (oauthError || !code) return oauthRedirect(res, oauthError === "access_denied" ? "cancelled" : "failed");
    const config = getOAuthConfig();
    if (!config) return oauthRedirect(res, "unavailable");

    const logXOauthFailure = (stage: "token exchange" | "user lookup" | "account linking", error?: unknown, reason?: string) => {
      const responseData = axios.isAxiosError(error) && error.response?.data && typeof error.response.data === "object"
        ? error.response.data as Record<string, unknown>
        : undefined;
      console.error(`[X OAuth] ${stage} failed`, {
        ...(reason ? { reason } : {}),
        ...(axios.isAxiosError(error) && typeof error.response?.status === "number" ? { status: error.response.status } : {}),
        ...(typeof responseData?.error === "string" ? { xErrorCode: responseData.error } : {}),
        ...(typeof responseData?.type === "string" ? { xErrorType: responseData.type } : {}),
        ...(typeof responseData?.error_description === "string" ? { xErrorDescription: responseData.error_description } : {}),
      });
    };

    let accessToken: string;
    try {
      const tokenResponse = await axios.post("https://api.x.com/2/oauth2/token", new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: config.redirectUri, code_verifier: oauthState.code_verifier }).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` }, timeout: 15000 });
      if (typeof tokenResponse.data?.access_token !== "string") {
        logXOauthFailure("token exchange", undefined, "missing_access_token");
        return oauthRedirect(res, "failed");
      }
      accessToken = tokenResponse.data.access_token;
      console.log("[X OAuth] token exchange succeeded", {
        tokenType: tokenResponse.data?.token_type,
        scope: tokenResponse.data?.scope,
        expiresIn: tokenResponse.data?.expires_in,
        hasRefreshToken: typeof tokenResponse.data?.refresh_token === "string",
      });
    } catch (error) {
      logXOauthFailure("token exchange", error);
      return oauthRedirect(res, "failed");
    }

    let xUser: { id: string; username: string; name?: string };
    try {
      const identityResponse = await axios.get("https://api.x.com/2/users/me", { params: { "user.fields": "username,name" }, headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 });
      const responseUser = identityResponse.data?.data;
      if (!responseUser || typeof responseUser.id !== "string" || typeof responseUser.username !== "string") {
        logXOauthFailure("user lookup", undefined, "invalid_user_response");
        return oauthRedirect(res, "failed");
      }
      xUser = responseUser;
      console.log("[X OAuth] user lookup succeeded");
    } catch (error) {
      logXOauthFailure("user lookup", error);
      return oauthRedirect(res, "failed");
    }

    try {
      const existing = statsDb.prepare(`SELECT id FROM ambassadors WHERE x_user_id = ?`).get(xUser.id) as any;
      if (existing && existing.id !== oauthState.ambassador_id) return oauthRedirect(res, "already-linked");
      const linked = statsDb.prepare(`UPDATE ambassadors SET x_user_id = ?, x_username = ?, x_display_name = ?, x_handle = ?, x_verified_at = ? WHERE id = ? AND status = 'approved'`).run(xUser.id, xUser.username, typeof xUser.name === "string" ? xUser.name : null, xUser.username, new Date().toISOString(), oauthState.ambassador_id);
      if (linked.changes !== 1) {
        logXOauthFailure("account linking", undefined, "ambassador_not_updated");
        return oauthRedirect(res, "failed");
      }
      console.log("[X OAuth] account linked successfully");
      return oauthRedirect(res, "linked");
    } catch (error) {
      logXOauthFailure("account linking", error);
      return oauthRedirect(res, "failed");
    }
  });

  app.post("/api/referrals/nonce", (req, res) => {
    const walletAddress = String(req.body.walletAddress || "");
    const referralCode = String(req.body.referralCode || "").trim();
    if (!isAddress(walletAddress) || !referralCode) return res.status(400).json({ error: "Invalid referral attribution" });
    const ambassador = statsDb.prepare(`SELECT id, wallet_address FROM ambassadors WHERE referral_code = ? AND status = 'approved'`).get(referralCode) as any;
    if (!ambassador || ambassador.wallet_address.toLowerCase() === walletAddress.toLowerCase()) return res.status(400).json({ error: "Referral code is not eligible" });
    const nonce = createOpaqueToken();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const message = `Dust Engine Referral Attribution\nWallet: ${walletAddress.toLowerCase()}\nReferral: ${referralCode}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}`;
    statsDb.prepare(`INSERT INTO referral_auth_nonces (nonce, ambassador_id, wallet_address, referral_code, message, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).run(nonce, ambassador.id, walletAddress.toLowerCase(), referralCode, message, expiresAt);
    res.json({ nonce, message });
  });

  app.post("/api/referrals/attribute", async (req, res) => {
    const { walletAddress, nonce, signature } = req.body;
    if (!isAddress(walletAddress) || typeof nonce !== "string" || typeof signature !== "string") return res.status(400).json({ error: "Invalid referral attribution" });
    const auth = statsDb.prepare(`SELECT * FROM referral_auth_nonces WHERE nonce = ? AND wallet_address = ? AND used_at IS NULL AND expires_at > ?`).get(nonce, walletAddress.toLowerCase(), Date.now()) as any;
    if (!auth || !(await verifyMessage({ address: walletAddress, message: auth.message, signature: signature as `0x${string}` }))) return res.status(401).json({ error: "Invalid referral proof" });
    const attributed = statsDb.transaction(() => {
      const now = new Date().toISOString();
      const claimed = statsDb.prepare(`UPDATE referral_auth_nonces SET used_at = ? WHERE nonce = ? AND wallet_address = ? AND used_at IS NULL AND expires_at > ?`)
        .run(now, nonce, walletAddress.toLowerCase(), Date.now());
      if (claimed.changes !== 1) return null;
      const inserted = statsDb.prepare(`INSERT OR IGNORE INTO referral_attributions (referred_wallet_address, ambassador_id, referral_code, created_at) VALUES (?, ?, ?, ?)`)
        .run(walletAddress.toLowerCase(), auth.ambassador_id, auth.referral_code, now);
      return inserted.changes === 1;
    })();
    if (attributed === null) return res.status(400).json({ error: "Referral proof expired or already used" });
    res.json({ success: attributed, alreadyAttributed: !attributed });
  });

  const persistAmbassadorActivity = (body: any): { status: number; payload: Record<string, unknown> } => {
    const { id, ambassadorId, kind, quantity, bridgeVolumeUsd, xPostContent, xPostUrl, xPostId, xUserId, xImpressions, xQualityScore, reviewer, reviewStatus, referredWalletAddress, completedAt } = body;
    if (typeof id !== "string" || !id.trim() || typeof ambassadorId !== "string" || !ambassadorId.trim() || !["referral_qualified", "clean_completed", "bridge_completed", "x_content"].includes(kind)) {
      return { status: 400, payload: { error: "Invalid activity event" } };
    }
    if (!statsDb.prepare(`SELECT 1 FROM ambassadors WHERE id = ? AND status = 'approved'`).get(ambassadorId)) {
      return { status: 400, payload: { error: "Ambassador is not approved" } };
    }
    const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
    const finiteNonNegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const resolvedReviewStatus = reviewStatus ?? (kind === "x_content" ? "pending" : "approved");
    if (!["pending", "approved", "rejected"].includes(resolvedReviewStatus)) return { status: 400, payload: { error: "Invalid review status" } };
    if (typeof completedAt !== "undefined" && (typeof completedAt !== "string" || Number.isNaN(Date.parse(completedAt)))) return { status: 400, payload: { error: "Invalid completion time" } };

    let normalizedQuantity = 0;
    let normalizedBridgeVolumeUsd = 0;
    let normalizedXImpressions = 0;
    let normalizedXQualityScore = 0;
    if (kind === "clean_completed") {
      if (!finiteNonNegative(quantity) || quantity <= 0 || has("bridgeVolumeUsd")) return { status: 400, payload: { error: "Clean Dust activity requires a positive quantity only" } };
      normalizedQuantity = quantity;
    } else if (kind === "bridge_completed") {
      if (!finiteNonNegative(bridgeVolumeUsd) || bridgeVolumeUsd <= 0 || has("quantity")) return { status: 400, payload: { error: "Bridge activity requires positive USD volume only" } };
      normalizedBridgeVolumeUsd = bridgeVolumeUsd;
    } else if (kind === "referral_qualified") {
      if (has("quantity") || has("bridgeVolumeUsd") || !isAddress(String(referredWalletAddress || ""))) return { status: 400, payload: { error: "A referred wallet is required and referral activity cannot include volume" } };
    } else {
      if (has("quantity") || has("bridgeVolumeUsd") || typeof xPostId !== "string" || !xPostId.trim() || typeof xUserId !== "string" || !xUserId.trim() || !finiteNonNegative(xQualityScore) || xQualityScore > 100 || !Number.isInteger(xImpressions) || xImpressions < 0) return { status: 400, payload: { error: "Invalid X content activity" } };
      normalizedXQualityScore = xQualityScore;
      normalizedXImpressions = xImpressions;
    }
    if (kind === "x_content") {
      const ambassadorXIdentity = statsDb.prepare(`SELECT x_user_id FROM ambassadors WHERE id = ?`).get(ambassadorId) as any;
      if (!ambassadorXIdentity?.x_user_id || xUserId !== ambassadorXIdentity.x_user_id) return { status: 400, payload: { error: "X content must match the verified X identity" } };
    }
    const timestamp = completedAt || new Date().toISOString();
    const recordActivity = statsDb.transaction(() => {
      if (statsDb.prepare(`SELECT 1 FROM ambassador_activity_events WHERE id = ?`).get(id)) return "duplicate-event";
      if (kind === "x_content" && statsDb.prepare(`SELECT 1 FROM ambassador_activity_events WHERE kind = 'x_content' AND x_post_id = ?`).get(xPostId)) return "duplicate-x-post";
      statsDb.prepare(`INSERT INTO ambassador_activity_events (id, ambassador_id, kind, quantity, bridge_volume_usd, x_post_content, x_post_url, x_post_id, x_user_id, x_impressions, x_quality_score, reviewer, review_status, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ambassadorId, kind, normalizedQuantity, normalizedBridgeVolumeUsd, typeof xPostContent === "string" ? xPostContent : null, typeof xPostUrl === "string" ? xPostUrl : null, kind === "x_content" ? xPostId : null, kind === "x_content" ? xUserId : null, normalizedXImpressions, normalizedXQualityScore, typeof reviewer === "string" ? reviewer : null, resolvedReviewStatus, timestamp);
      if (kind === "referral_qualified") {
        const qualified = statsDb.prepare(`UPDATE referral_attributions SET status = 'qualified', qualified_at = ? WHERE referred_wallet_address = ? AND ambassador_id = ? AND status = 'pending'`)
          .run(new Date().toISOString(), String(referredWalletAddress).toLowerCase(), ambassadorId);
        if (qualified.changes !== 1) throw new Error("Referral attribution is no longer pending");
      }
      return "recorded";
    });
    try {
      const result = recordActivity();
      if (result !== "recorded") return { status: 200, payload: { success: true, duplicate: result } };
      return { status: 200, payload: { success: true } };
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return { status: 200, payload: { success: true, duplicate: "existing-activity" } };
      return { status: 400, payload: { error: error instanceof Error ? error.message : "Unable to record activity" } };
    }
  };

  // Reserved for trusted server-side/indexer jobs only. It is deliberately not used by
  // the frontend, so wallet users cannot submit their own activity or leaderboard score.
  app.post("/api/internal/ambassador-activity", (req, res) => {
    const adminToken = process.env.AMBASSADOR_ADMIN_TOKEN;
    if (!adminToken || req.header("x-ambassador-admin-token") !== adminToken) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const result = persistAmbassadorActivity(req.body || {});
    return res.status(result.status).json(result.payload);
  });

  app.post("/api/internal/ambassador/verify-clean", async (req, res) => {
    const adminToken = process.env.AMBASSADOR_ADMIN_TOKEN;
    if (!adminToken || req.header("x-ambassador-admin-token") !== adminToken) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const txHash = req.body?.txHash;
    if (typeof txHash !== "string") return res.status(400).json({ error: "txHash is required" });
    const rpcUrl = process.env.BASE_RPC_URL;
    if (!rpcUrl) return res.status(503).json({ error: "Clean Dust verification is not configured" });
    const configuredConfirmations = Number.parseInt(process.env.AMBASSADOR_MIN_CONFIRMATIONS || "3", 10);
    const verification = await verifyCleanDustTransaction({
      txHash,
      client: createPublicClient({ chain: base, transport: http(rpcUrl) }),
      minimumConfirmations: Number.isInteger(configuredConfirmations) && configuredConfirmations > 0 ? configuredConfirmations : 3,
      findApprovedAmbassadorId: (walletAddress) => (getApprovedAmbassadorIdByWallet.get(walletAddress) as { id?: string } | undefined)?.id,
    });
    if (!verification.ok) return res.status(400).json({ error: verification.reason });
    const result = persistAmbassadorActivity({
      id: verification.eventId,
      ambassadorId: verification.ambassadorId,
      kind: "clean_completed",
      quantity: verification.quantity,
      completedAt: verification.completedAt,
      reviewStatus: "approved",
    });
    return res.status(result.status).json(result.payload);
  });

  // Scan endpoint - YOUR ORIGINAL FUNCTION
  app.get("/api/scan/:address", async (req, res) => {
    const { address } = req.params;
    
    if (!address || address === "undefined" || !address.startsWith("0x") || address.length < 40) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const tokens = new Map<string, any>();

    const mergeToken = (candidate: any) => {
      const key = candidate.address.toLowerCase();
      const existing = tokens.get(key);

      if (!existing) {
        tokens.set(key, candidate);
        return;
      }

      tokens.set(key, {
        ...existing,
        address: existing.address || candidate.address,
        symbol: existing.symbol || candidate.symbol,
        name: existing.name || candidate.name,
        decimals: existing.decimals ?? candidate.decimals,
        balance:
          existing.balance && existing.balance !== "0"
            ? existing.balance
            : candidate.balance,
        priceUsd:
          existing.priceUsd > 0 ? existing.priceUsd : candidate.priceUsd,
        source:
          existing.source === candidate.source
            ? existing.source
            : `${existing.source},${candidate.source}`,
      });
    };

    try {
      // 1. Blockscout Balances
      try {
        console.log("Fetching from Blockscout...");

        const blockscoutRes = await axios.get(
          `https://base.blockscout.com/api/v2/addresses/${address}/token-balances`,
          { timeout: 30000 }
        );

        console.log("Blockscout response:", blockscoutRes.data);
        const items = Array.isArray(blockscoutRes.data) ? blockscoutRes.data : (blockscoutRes.data.items || []);
        console.log("Parsed items count:", items.length);
        items.forEach((t: any) => {
          if (t.token?.address_hash) {
            mergeToken({
              symbol: t.token.symbol,
              name: t.token.name,
              address: t.token.address_hash,
              decimals: parseInt(t.token.decimals || '18'),
              balance: t.value || "0", // 🔥 THIS IS CRITICAL
              priceUsd: parseFloat(t.token.exchange_rate || "0"),
              source: 'indexer'
            });
          }
        });
      } catch (e: any) {
        console.warn("Blockscout balances failed:", e.message);
      }
      
      // 2. Blockscout Transfers
      try {
        const historyRes = await axios.get(`https://base.blockscout.com/api/v2/addresses/${address}/token-transfers`, {
          params: { limit: 50 },
          timeout: 30000
        });
        const historyItems = Array.isArray(historyRes.data) ? historyRes.data : (historyRes.data.items || []);
        historyItems.forEach((t: any) => {
          if (t.token?.address_hash && t.token?.type === 'ERC-20') {
            mergeToken({
              symbol: t.token.symbol,
              name: t.token.name,
              address: t.token.address_hash,
              decimals: parseInt(t.token.decimals || '18'),
              balance: "0",
              priceUsd: parseFloat(t.token.exchange_rate || "0"),
              source: 'history'
            });
          }
        });
      } catch (e: any) {
        if (e.response?.status !== 422) {
          console.warn("Blockscout transfers failed:", e.message);
        }
      }

      res.json({ tokens: Array.from(tokens.values()) });
    } catch (error: any) {
      console.error("Critical backend scan failure:", error.message);
      res.status(500).json({ error: "Internal server error during scan" });
    }
  });

  app.get("/api/swap/quote", async (req, res) => {
    const { src, dst, amount, from } = req.query;

    console.log("🧪 LI.FI PARAMS:", { src, dst, amount, from });

    if (!src || !dst || !amount || !from) {
      return res.status(400).json({
        error: "Missing required params",
        received: { src, dst, amount, from }
      });
    }

    try {
      const response = await axios.get("https://li.quest/v1/quote", {
        params: {
          fromChain: 8453, // Base
          toChain: 8453,
          fromToken: src,
          toToken: dst,
          fromAddress: from,
          fromAmount: amount,
        },
        timeout: 10000
      });

      if (!response.data.transactionRequest) {
        console.log("❌ NO ROUTE FROM LI.FI:", response.data);
        return res.status(500).json({
          error: "No route found",
          full: response.data
        });
      }

      // ⚠️ Adapt response to your frontend format
      const tx = response.data.transactionRequest;
      const approvalAddress = response.data.estimate?.approvalAddress;

      res.json({
        tx: {
          to: tx.to,
          data: tx.data,
          value: tx.value || "0",
          gas: tx.gasLimit || "1500000"
        },
        approvalAddress
      });

    } catch (e: any) {
      console.error("LI.FI failed:", e.response?.data || e.message);
      res.status(500).json(e.response?.data || { error: "LI.FI quote failed" });
    }
  });

  // Proxy for merkle.io to avoid CORS
  app.post('/api/proxy/merkle', async (req, res) => {
    try {
      console.log('Proxying request to merkle.io');
      const response = await axios.post('https://eth.merkle.io/', req.body, {
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://dust-engine.onrender.com',
          'User-Agent': 'DustEngine/1.0'
        },
        timeout: 10000
      });
      res.json(response.data);
    } catch (error: any) {
      console.error('Merkle proxy error:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      res.status(error.response?.status || 500).json({ 
        error: 'Proxy request failed',
        details: error.message 
      });
    }
  });

  // Proxy for hey.xyz ENS resolution
  app.get('/api/proxy/ens/:address', async (req, res) => {
    try {
      const { address } = req.params;
      console.log(`Proxying ENS request for address: ${address}`);
      const response = await axios.get(`https://api.hey.xyz/ens/ccip/${address}`, {
        headers: {
          'Origin': 'https://dust-engine.onrender.com',
          'User-Agent': 'DustEngine/1.0'
        },
        timeout: 10000
      });
      res.json(response.data);
    } catch (error: any) {
      console.error('ENS proxy error:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      res.status(error.response?.status || 500).json({ 
        error: 'ENS resolution failed',
        details: error.message 
      });
    }
  });

  // ===== STATIC FILES =====
  const distPath = path.join(__dirname, "dist");
  console.log(`Serving static files from: ${distPath}`);
  app.use(express.static(distPath));

  app.use("/.well-known", express.static(path.join(__dirname, "public/.well-known")));

  app.post('/api/webhook', (req, res) => {
    console.log('Farcaster webhook received');
    res.status(200).json({ success: true });
  });

  app.get('/api/webhook', (req, res) => {
    res.status(200).json({ success: true });
  });

  // Catch-all route - serve index.html for client-side routing
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: `API endpoint ${req.path} not found` });
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health: http://0.0.0.0:${PORT}/api/health`);
    console.log(`Stats: http://0.0.0.0:${PORT}/api/stats`);
    console.log(`Scan: http://0.0.0.0:${PORT}/api/scan/0x...`);
  });
}

startServer().catch(console.error);
