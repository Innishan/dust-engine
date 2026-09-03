import crypto from "crypto";
import { parseXContentEvaluation, RetryableQualityError, type XContentEvaluation } from "./ambassadorXQuality";

type SqliteDatabase = any;

export type XPost = {
  id: string;
  authorId: string;
  text: string;
  referencedText?: string;
  isRepost: boolean;
  isQuote: boolean;
  impressions: number;
  createdAt?: string;
};

export type XContentClient = {
  getPost(postId: string): Promise<XPost | null>;
  syncRules(): Promise<void>;
  stream(signal: AbortSignal, onPostId: (postId: string) => Promise<void>): Promise<void>;
  recentSearch(startTime: string): Promise<XPost[]>;
};

type CandidateStatus = "processing" | "approved" | "rejected" | "evaluation_failed";
type Candidate = { post_id: string; author_id: string | null; status: CandidateStatus; retry_count: number; next_retry_at: string | null; updated_at: string };

export type ProcessResult = { status: "approved" | "rejected" | "deferred" | "duplicate"; reason?: string; points?: number };

export const X_DISCOVERY_RULE = '("Dust Engine" OR @DustEngine OR @dustengineapp OR "dustengine.xyz" OR #DustEngine OR dustengine) -is:retweet';
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const NEAR_DUPLICATE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const PROCESSING_STALE_MS = 30 * 60 * 1000;

export function initializeXContentTables(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ambassador_x_content_candidates (
      x_post_id TEXT PRIMARY KEY,
      author_id TEXT,
      post_content TEXT,
      referenced_content TEXT,
      normalized_content TEXT,
      content_fingerprint TEXT,
      discovery_source TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'approved', 'rejected', 'evaluation_failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      evaluation_json TEXT,
      rejection_reason TEXT,
      discovered_at TEXT NOT NULL,
      processed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ambassador_x_content_candidates_status_retry ON ambassador_x_content_candidates(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS ambassador_x_content_candidates_author_created ON ambassador_x_content_candidates(author_id, created_at);
    CREATE TABLE IF NOT EXISTS ambassador_x_content_runtime_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function normalizeXContent(value: string): string {
  return value.toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@[a-z0-9_]+/gi, " ")
    .replace(/#[a-z0-9_]+/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprint(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tokens(value: string) {
  return normalizeXContent(value).split(" ").filter((token) => token.length > 2 && !new Set(["the", "and", "for", "with", "that", "this", "from", "your", "about"]).has(token));
}

function shingleSimilarity(left: string, right: string) {
  const toShingles = (input: string) => {
    const words = tokens(input);
    if (words.length < 3) return new Set(words);
    return new Set(words.slice(0, -2).map((_, index) => words.slice(index, index + 3).join(" ")));
  };
  const a = toShingles(left);
  const b = toShingles(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const shingleScore = intersection / (a.size + b.size - intersection);
  const wordsA = new Set(tokens(left));
  const wordsB = new Set(tokens(right));
  let wordIntersection = 0;
  for (const word of wordsA) if (wordsB.has(word)) wordIntersection += 1;
  const wordScore = wordsA.size && wordsB.size ? wordIntersection / (wordsA.size + wordsB.size - wordIntersection) : 0;
  return Math.max(shingleScore, wordScore);
}

export function hasDiscoverySignal(content: string) {
  return /\bdust\s*engine\b|@dustengine(?:app)?\b|dustengine\.xyz|#dustengine\b|\bdustengine\b/i.test(content);
}

export function calculateXContentPoints(qualityScore: number, impressions: number) {
  const quality = Math.min(100, Math.max(0, Math.round(qualityScore)));
  const impressionCount = Math.max(0, Math.floor(impressions));
  return 100 + (quality * 5) + Math.floor(Math.log10(impressionCount + 1) * 100);
}

function deterministicSpamReason(content: string) {
  const stripped = content.replace(/https?:\/\/\S+/g, "").trim();
  if (!/[a-z]/i.test(stripped)) return "empty_or_link_only";
  if (/(.)\1{8,}/i.test(stripped)) return "repeated_character_spam";
  if (/\b(?:airdrop|giveaway|100x|guaranteed profit|dm me)\b/i.test(stripped)) return "obvious_spam";
  return null;
}

function isMeaningfulQuoteCommentary(content: string) {
  return /[a-z0-9]/i.test(content.replace(/https?:\/\/\S+/g, ""));
}

export class XContentProcessor {
  constructor(private readonly options: {
    db: SqliteDatabase;
    client: Pick<XContentClient, "getPost">;
    evaluate: (input: { content: string; context?: string }) => Promise<XContentEvaluation>;
    recordApprovedActivity: (activity: { id: string; ambassadorId: string; kind: "x_content"; xPostContent: string; xPostUrl: string; xPostId: string; xUserId: string; xImpressions: number; xQualityScore: number; reviewStatus: "approved"; completedAt?: string }) => { status: number; payload: Record<string, unknown> };
    qualityThreshold: number;
    now?: () => Date;
  }) {}

  private now() { return this.options.now?.() || new Date(); }
  private nowIso() { return this.now().toISOString(); }

  private claim(postId: string, source: string): Candidate | null {
    const now = this.nowIso();
    const inserted = this.options.db.prepare(`INSERT OR IGNORE INTO ambassador_x_content_candidates (x_post_id, discovery_source, status, discovered_at, created_at, updated_at) VALUES (?, ?, 'processing', ?, ?, ?)`).run(postId, source, now, now, now);
    const candidate = this.options.db.prepare(`SELECT x_post_id, author_id, status, retry_count, next_retry_at, updated_at FROM ambassador_x_content_candidates WHERE x_post_id = ?`).get(postId) as Candidate | undefined;
    if (!candidate) return null;
    if (inserted.changes === 1) return candidate;
    if (candidate.status === "approved" || candidate.status === "rejected") return null;
    if (candidate.status === "processing") {
      const updatedAt = Date.parse(candidate.updated_at);
      if (Number.isNaN(updatedAt) || this.now().getTime() - updatedAt < PROCESSING_STALE_MS) return null;
      const reclaimed = this.options.db.prepare(`UPDATE ambassador_x_content_candidates SET updated_at = ? WHERE x_post_id = ? AND status = 'processing' AND updated_at = ?`)
        .run(now, postId, candidate.updated_at);
      return reclaimed.changes === 1 ? candidate : null;
    }
    if (candidate.next_retry_at && Date.parse(candidate.next_retry_at) > this.now().getTime()) return null;
    const claimed = this.options.db.prepare(`UPDATE ambassador_x_content_candidates SET status = 'processing', updated_at = ? WHERE x_post_id = ? AND status = 'evaluation_failed' AND (next_retry_at IS NULL OR next_retry_at <= ?)`)
      .run(now, postId, now);
    return claimed.changes === 1 ? candidate : null;
  }

  private reject(postId: string, reason: string, evaluation?: XContentEvaluation): ProcessResult {
    this.options.db.prepare(`UPDATE ambassador_x_content_candidates SET status = 'rejected', rejection_reason = ?, evaluation_json = COALESCE(?, evaluation_json), next_retry_at = NULL, processed_at = ?, updated_at = ? WHERE x_post_id = ?`)
      .run(reason, evaluation ? JSON.stringify(evaluation) : null, this.nowIso(), this.nowIso(), postId);
    return { status: "rejected", reason };
  }

  private defer(postId: string, error: unknown): ProcessResult {
    const candidate = this.options.db.prepare(`SELECT retry_count FROM ambassador_x_content_candidates WHERE x_post_id = ?`).get(postId) as { retry_count: number } | undefined;
    const retryCount = Math.max(0, Number(candidate?.retry_count) || 0) + 1;
    if (retryCount > MAX_RETRIES) return this.reject(postId, "automatic_retry_exhausted");
    const delay = Math.min(RETRY_BASE_MS * (2 ** (retryCount - 1)), RETRY_MAX_MS);
    const nextRetry = new Date(this.now().getTime() + delay).toISOString();
    const message = error instanceof Error ? error.message.slice(0, 500) : "temporary_x_or_evaluation_failure";
    this.options.db.prepare(`UPDATE ambassador_x_content_candidates SET status = 'evaluation_failed', retry_count = ?, next_retry_at = ?, last_error = ?, updated_at = ? WHERE x_post_id = ?`)
      .run(retryCount, nextRetry, message, this.nowIso(), postId);
    return { status: "deferred", reason: "temporary_failure" };
  }

  async processPostId(postId: string, source: string): Promise<ProcessResult> {
    if (!/^[0-9]{5,30}$/.test(postId)) return { status: "rejected", reason: "invalid_post_id" };
    const candidate = this.claim(postId, source);
    if (!candidate) return { status: "duplicate" };
    try {
      const post = await this.options.client.getPost(postId);
      if (!post) return this.reject(postId, "post_unavailable");
      return await this.processClaimedPost(post, candidate);
    } catch (error) {
      if ((error as Error & { permanent?: boolean }).permanent) return this.reject(postId, "post_unavailable");
      return this.defer(postId, error);
    }
  }

  async processRecoveredPost(post: XPost): Promise<ProcessResult> {
    if (!/^[0-9]{5,30}$/.test(post.id)) return { status: "rejected", reason: "invalid_post_id" };
    const candidate = this.claim(post.id, "recent_search");
    if (!candidate) return { status: "duplicate" };
    try {
      return await this.processClaimedPost(post, candidate);
    } catch (error) {
      return this.defer(post.id, error);
    }
  }

  private async processClaimedPost(post: XPost, candidate: Candidate): Promise<ProcessResult> {
    const now = this.nowIso();
    if (!post.authorId || !post.text) return this.reject(post.id, "invalid_x_post");
    if (candidate.author_id && candidate.author_id !== post.authorId) return this.reject(post.id, "author_mismatch");
    const normalized = normalizeXContent(post.text);
    const contentFingerprint = fingerprint(normalized);
    this.options.db.prepare(`UPDATE ambassador_x_content_candidates SET author_id = ?, post_content = ?, referenced_content = ?, normalized_content = ?, content_fingerprint = ?, updated_at = ? WHERE x_post_id = ?`)
      .run(post.authorId, post.text, post.referencedText || null, normalized, contentFingerprint, now, post.id);
    const ambassador = this.options.db.prepare(`SELECT id, x_user_id FROM ambassadors WHERE x_user_id = ? AND status = 'approved'`).get(post.authorId) as { id: string; x_user_id: string } | undefined;
    if (!ambassador || ambassador.x_user_id !== post.authorId) return this.reject(post.id, "unverified_or_unapproved_author");
    if (this.options.db.prepare(`SELECT 1 FROM ambassador_activity_events WHERE kind = 'x_content' AND x_post_id = ?`).get(post.id)) return this.reject(post.id, "post_already_awarded");
    if (post.isRepost) return this.reject(post.id, "repost_without_original_commentary");
    if (post.isQuote && !isMeaningfulQuoteCommentary(post.text)) return this.reject(post.id, "quote_without_meaningful_commentary");
    if (!hasDiscoverySignal(`${post.text}\n${post.referencedText || ""}`)) return this.reject(post.id, "missing_dust_engine_signal");
    const spamReason = deterministicSpamReason(post.text);
    if (spamReason) return this.reject(post.id, spamReason);
    const exact = this.options.db.prepare(`SELECT x_post_id FROM ambassador_x_content_candidates WHERE x_post_id != ? AND content_fingerprint = ? AND status = 'approved' LIMIT 1`).get(post.id, contentFingerprint);
    if (exact) return this.reject(post.id, "exact_duplicate_content");
    const recentRows = this.options.db.prepare(`SELECT normalized_content FROM ambassador_x_content_candidates WHERE x_post_id != ? AND author_id = ? AND status = 'approved' AND created_at >= ? ORDER BY created_at DESC LIMIT 30`)
      .all(post.id, post.authorId, new Date(this.now().getTime() - NEAR_DUPLICATE_WINDOW_MS).toISOString()) as { normalized_content: string }[];
    if (recentRows.some((row) => shingleSimilarity(normalized, row.normalized_content) >= 0.85)) return this.reject(post.id, "near_duplicate_content");
    let evaluation: XContentEvaluation;
    try {
      evaluation = parseXContentEvaluation(await this.options.evaluate({ content: post.text, context: post.referencedText }));
    } catch (error) {
      return this.defer(post.id, error instanceof RetryableQualityError ? error : new RetryableQualityError("quality_evaluation_failed"));
    }
    const qualityScore = Math.min(100, Math.max(0, Math.round(evaluation.qualityScore)));
    if (!evaluation.eligible || evaluation.relevance < 40 || evaluation.spamLikelihood >= 60) return this.reject(post.id, "quality_evaluation_ineligible", evaluation);
    if (qualityScore < this.options.qualityThreshold) return this.reject(post.id, "below_quality_threshold", evaluation);
    const impressions = Math.max(0, Math.floor(Number(post.impressions) || 0));
    const points = calculateXContentPoints(qualityScore, impressions);
    const persisted = this.options.recordApprovedActivity({
      id: `x:${post.id}`,
      ambassadorId: ambassador.id,
      kind: "x_content",
      xPostContent: post.text,
      xPostUrl: `https://x.com/i/web/status/${post.id}`,
      xPostId: post.id,
      xUserId: post.authorId,
      xImpressions: impressions,
      xQualityScore: qualityScore,
      reviewStatus: "approved",
      completedAt: post.createdAt,
    });
    if (persisted.status !== 200 || persisted.payload.duplicate) return this.reject(post.id, "post_already_awarded", evaluation);
    this.options.db.prepare(`UPDATE ambassador_x_content_candidates SET status = 'approved', evaluation_json = ?, rejection_reason = NULL, next_retry_at = NULL, last_error = NULL, processed_at = ?, updated_at = ? WHERE x_post_id = ?`)
      .run(JSON.stringify(evaluation), this.nowIso(), this.nowIso(), post.id);
    return { status: "approved", points };
  }

  async retryDueCandidates() {
    const due = this.options.db.prepare(`SELECT x_post_id FROM ambassador_x_content_candidates WHERE status = 'evaluation_failed' AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT 20`).all(this.nowIso()) as { x_post_id: string }[];
    for (const candidate of due) await this.processPostId(candidate.x_post_id, "automatic_retry");
  }
}

export class XApiClient implements XContentClient {
  constructor(private readonly bearerToken: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request(path: string) {
    const response = await this.fetchImpl(`https://api.x.com/2${path}`, { headers: { Authorization: `Bearer ${this.bearerToken}` } });
    if (!response.ok) {
      const error = new Error(`X API request failed with ${response.status}`);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) (error as Error & { permanent?: boolean }).permanent = true;
      throw error;
    }
    return response.json() as Promise<any>;
  }

  async getPost(postId: string): Promise<XPost | null> {
    const data = await this.request(`/tweets/${postId}?tweet.fields=author_id,created_at,public_metrics,referenced_tweets&expansions=referenced_tweets.id`);
    const post = data?.data;
    if (!post) return null;
    const referenced = Array.isArray(post.referenced_tweets) ? post.referenced_tweets : [];
    const referencedIds = new Set(referenced.map((entry: any) => entry.id));
    const included = Array.isArray(data?.includes?.tweets) ? data.includes.tweets : [];
    return {
      id: String(post.id), authorId: String(post.author_id || ""), text: String(post.text || ""),
      referencedText: included.filter((entry: any) => referencedIds.has(entry.id)).map((entry: any) => String(entry.text || "")).join("\n"),
      isRepost: referenced.some((entry: any) => entry.type === "retweeted"), isQuote: referenced.some((entry: any) => entry.type === "quoted"),
      impressions: Number(post.public_metrics?.impression_count || 0), createdAt: typeof post.created_at === "string" ? post.created_at : undefined,
    };
  }

  async syncRules() {
    const existing = await this.request("/tweets/search/stream/rules");
    const managed = (existing.data || []).filter((rule: any) => rule.tag === "dust-engine-ambassador");
    const matching = managed.find((rule: any) => rule.value === X_DISCOVERY_RULE);
    if (matching && managed.length === 1) return;
    if (managed.length) await this.requestWithBody("/tweets/search/stream/rules", { delete: { ids: managed.map((rule: any) => rule.id) } });
    await this.requestWithBody("/tweets/search/stream/rules", { add: [{ value: X_DISCOVERY_RULE, tag: "dust-engine-ambassador" }] });
  }

  private async requestWithBody(path: string, body: unknown) {
    const response = await this.fetchImpl(`https://api.x.com/2${path}`, { method: "POST", headers: { Authorization: `Bearer ${this.bearerToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`X API request failed with ${response.status}`);
    return response.json();
  }

  async stream(signal: AbortSignal, onPostId: (postId: string) => Promise<void>) {
    const response = await this.fetchImpl("https://api.x.com/2/tweets/search/stream?tweet.fields=author_id,created_at,public_metrics,referenced_tweets&expansions=referenced_tweets.id", { headers: { Authorization: `Bearer ${this.bearerToken}` }, signal });
    if (!response.ok || !response.body) throw new Error(`X stream failed with ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (typeof event?.data?.id === "string") await onPostId(event.data.id);
        } catch { /* malformed stream events are ignored; recovery covers gaps */ }
      }
    }
  }

  async recentSearch(startTime: string): Promise<XPost[]> {
    const query = encodeURIComponent(X_DISCOVERY_RULE);
    const start = encodeURIComponent(startTime);
    const data = await this.request(`/tweets/search/recent?query=${query}&start_time=${start}&max_results=100&tweet.fields=author_id,created_at,public_metrics,referenced_tweets&expansions=referenced_tweets.id`);
    const included = Array.isArray(data?.includes?.tweets) ? data.includes.tweets : [];
    return (data?.data || []).map((post: any) => {
      const referenced = Array.isArray(post.referenced_tweets) ? post.referenced_tweets : [];
      const referencedIds = new Set(referenced.map((entry: any) => entry.id));
      return { id: String(post.id), authorId: String(post.author_id || ""), text: String(post.text || ""), referencedText: included.filter((entry: any) => referencedIds.has(entry.id)).map((entry: any) => String(entry.text || "")).join("\n"), isRepost: referenced.some((entry: any) => entry.type === "retweeted"), isQuote: referenced.some((entry: any) => entry.type === "quoted"), impressions: Number(post.public_metrics?.impression_count || 0), createdAt: typeof post.created_at === "string" ? post.created_at : undefined };
    });
  }
}

export class XContentWorker {
  private controller: AbortController | null = null;
  private streamTask: Promise<void> | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private recoveryRunning = false;

  constructor(private readonly options: { db: SqliteDatabase; client: XContentClient; processor: XContentProcessor; recoveryIntervalMs: number; now?: () => Date }) {}
  private now() { return this.options.now?.() || new Date(); }

  start() {
    this.stopped = false;
    void this.recover();
    this.recoveryTimer = setInterval(() => void this.recover(), this.options.recoveryIntervalMs);
    this.streamTask = this.runStream();
  }

  private async runStream() {
    let attempt = 0;
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        await this.options.client.syncRules();
        await this.options.client.stream(this.controller.signal, async (postId) => { await this.options.processor.processPostId(postId, "filtered_stream"); });
        attempt = 0;
      } catch (error) {
        if (this.stopped || this.controller.signal.aborted) break;
        attempt = Math.min(attempt + 1, 6);
        const delay = Math.min(1_000 * (2 ** attempt), 60_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async recover() {
    if (this.recoveryRunning) return;
    this.recoveryRunning = true;
    try {
      await this.options.processor.retryDueCandidates();
      const previous = this.options.db.prepare(`SELECT value FROM ambassador_x_content_runtime_state WHERE key = 'last_recovery_at'`).get() as { value?: string } | undefined;
      const overlapMs = 15 * 60 * 1000;
      const earliest = this.now().getTime() - (7 * 24 * 60 * 60 * 1000) + overlapMs;
      const start = Math.max(earliest, (previous?.value ? Date.parse(previous.value) : this.now().getTime() - overlapMs) - overlapMs);
      const posts = await this.options.client.recentSearch(new Date(start).toISOString());
      for (const post of posts) await this.options.processor.processRecoveredPost(post);
      const now = this.now().toISOString();
      this.options.db.prepare(`INSERT INTO ambassador_x_content_runtime_state (key, value, updated_at) VALUES ('last_recovery_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(now, now);
    } catch (error) {
      console.warn("[Ambassador X] recovery temporarily failed", error instanceof Error ? error.message : "unknown error");
    } finally {
      this.recoveryRunning = false;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    this.controller?.abort();
    await this.streamTask?.catch(() => undefined);
  }
}
