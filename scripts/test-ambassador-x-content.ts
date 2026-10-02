import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { classifyGeminiProviderFailure, evaluateXContent, parseXContentEvaluationText, RetryableQualityError, type XContentEvaluation } from "../server/ambassadorXQuality";
import { DEFAULT_X_CONTENT_RECOVERY_INTERVAL_MS, X_CONTENT_RECOVERY_OVERLAP_MS, X_DISCOVERY_RULE, XContentProcessor, XContentWorker, calculateXContentPoints, hasDiscoverySignal, initializeXContentTables, requeueCandidatesForVerifiedAuthor, resetTemporaryLostXContentCandidates, recoverySearchStart, type ProcessResult, type XPost } from "../server/ambassadorXContent";

const database = new Database(":memory:");
database.exec(`
  CREATE TABLE ambassadors (id TEXT PRIMARY KEY, x_user_id TEXT UNIQUE, status TEXT NOT NULL);
  CREATE TABLE ambassador_activity_events (id TEXT PRIMARY KEY, ambassador_id TEXT NOT NULL, kind TEXT NOT NULL, x_post_id TEXT, x_user_id TEXT, x_impressions INTEGER, x_quality_score REAL, review_status TEXT NOT NULL);
  CREATE UNIQUE INDEX ambassador_x_content_post_unique ON ambassador_activity_events(x_post_id) WHERE kind = 'x_content' AND x_post_id IS NOT NULL;
`);
initializeXContentTables(database);
database.prepare(`INSERT INTO ambassadors (id, x_user_id, status) VALUES ('ambassador-1', 'user-1', 'approved'), ('ambassador-2', 'user-2', 'revoked')`).run();

const highQuality: XContentEvaluation = { relevance: 90, usefulness: 85, originality: 80, genuineExperience: 80, clarity: 90, creativity: 65, spamLikelihood: 5, eligible: true, qualityScore: 80 };
let now = new Date("2026-09-01T00:00:00.000Z");
const posts = new Map<string, XPost>();
const failures = new Map<string, Error>();
let evaluation: XContentEvaluation = highQuality;
let evaluationFailure: Error | null = null;
const forcedDuplicateIds = new Set<string>();
const awards: Array<Record<string, unknown>> = [];
let getPostCalls = 0;
const insertAmbassador = database.prepare(`INSERT INTO ambassadors (id, x_user_id, status) VALUES (?, ?, 'approved')`);

const processor = new XContentProcessor({
  db: database,
  client: { getPost: async (id) => { getPostCalls += 1; const failure = failures.get(id); if (failure) throw failure; return posts.get(id) || null; } },
  evaluate: async () => { if (evaluationFailure) throw evaluationFailure; return evaluation; },
  now: () => now,
  recordApprovedActivity: (activity) => {
    assert.equal(activity.kind, "x_content", "approved X posts must be persisted as X-content activity");
    assert.equal(Object.prototype.hasOwnProperty.call(activity, "points"), false, "points are never accepted from caller input");
    if (forcedDuplicateIds.has(activity.xPostId)) return { status: 200, payload: { duplicate: "existing" } };
    if (database.prepare(`SELECT 1 FROM ambassador_activity_events WHERE x_post_id = ?`).get(activity.xPostId)) return { status: 200, payload: { duplicate: "existing" } };
    database.prepare(`INSERT INTO ambassador_activity_events (id, ambassador_id, kind, x_post_id, x_user_id, x_impressions, x_quality_score, review_status) VALUES (?, ?, 'x_content', ?, ?, ?, ?, 'approved')`)
      .run(activity.id, activity.ambassadorId, activity.xPostId, activity.xUserId, activity.xImpressions, activity.xQualityScore);
    awards.push(activity);
    return { status: 200, payload: { success: true } };
  },
});

function post(id: string, overrides: Partial<XPost> = {}): XPost {
  return { id, authorId: "user-1", text: "Dust Engine found forgotten ERC20 dust in my Base wallet and made cleanup much simpler.", isRepost: false, isQuote: false, impressions: 999, createdAt: now.toISOString(), ...overrides };
}

const temporaryRecoveryTargets = [
  { xPostId: "2104131232456221005", authorId: "932353843899142144", discoveredAt: "2026-09-27T08:49:17.858Z" },
  { xPostId: "2104114823906906298", authorId: "1656263788335861760", discoveredAt: "2026-09-27T07:44:05.631Z" },
] as const;

function createTemporaryRecoveryDatabase() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE ambassadors (id TEXT PRIMARY KEY, x_user_id TEXT UNIQUE, status TEXT NOT NULL);
    CREATE TABLE ambassador_activity_events (id TEXT PRIMARY KEY, ambassador_id TEXT NOT NULL, kind TEXT NOT NULL, x_post_id TEXT, review_status TEXT NOT NULL);
  `);
  initializeXContentTables(db);
  return db;
}

function insertTemporaryRecoveryTarget(db: Database.Database, target: typeof temporaryRecoveryTargets[number], overrides: { authorId?: string; ambassadorXUserId?: string; ambassadorStatus?: string; status?: string; retryCount?: number; lastError?: string | null; rejectionReason?: string | null; discoverySource?: string; discoveredAt?: string; activity?: boolean } = {}) {
  db.prepare(`INSERT INTO ambassadors (id, x_user_id, status) VALUES (?, ?, ?)`).run(`amb-${target.xPostId}`, overrides.ambassadorXUserId || target.authorId, overrides.ambassadorStatus || "approved");
  db.prepare(`INSERT INTO ambassador_x_content_candidates (x_post_id, author_id, discovery_source, status, retry_count, next_retry_at, last_error, rejection_reason, discovered_at, processed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '2026-09-01T00:00:00.000Z', ?, ?, ?, '2026-09-28T00:00:00.000Z', '2026-09-27T00:00:00.000Z', '2026-09-28T00:00:00.000Z')`)
    .run(target.xPostId, overrides.authorId || target.authorId, overrides.discoverySource || "filtered_stream", overrides.status || "rejected", overrides.retryCount ?? 0, overrides.lastError ?? null, overrides.rejectionReason ?? "quality_evaluation_ineligible", overrides.discoveredAt || target.discoveredAt);
  if (overrides.activity) db.prepare(`INSERT INTO ambassador_activity_events (id, ambassador_id, kind, x_post_id, review_status) VALUES (?, ?, 'x_content', ?, 'approved')`).run(`activity-${target.xPostId}`, `amb-${target.xPostId}`, target.xPostId);
}

const recoveryDb = createTemporaryRecoveryDatabase();
for (const target of temporaryRecoveryTargets) insertTemporaryRecoveryTarget(recoveryDb, target);
const recoveryNow = new Date("2026-10-01T12:34:56.000Z");
const recoveryResult = resetTemporaryLostXContentCandidates(recoveryDb, recoveryNow);
assert.deepEqual(recoveryResult, { reset: temporaryRecoveryTargets.map((target) => target.xPostId), skipped: [] }, "both exact allowlisted candidates reset when every safeguard matches");
for (const target of temporaryRecoveryTargets) {
  const row = recoveryDb.prepare(`SELECT status, retry_count, next_retry_at, last_error, rejection_reason, processed_at, updated_at FROM ambassador_x_content_candidates WHERE x_post_id = ?`).get(target.xPostId) as { status: string; retry_count: number; next_retry_at: string; last_error: string | null; rejection_reason: string | null; processed_at: string | null; updated_at: string };
  assert.deepEqual(row, { status: "evaluation_failed", retry_count: 0, next_retry_at: recoveryNow.toISOString(), last_error: null, rejection_reason: null, processed_at: null, updated_at: recoveryNow.toISOString() });
}
assert.equal(recoveryDb.prepare(`SELECT COUNT(*) AS count FROM ambassador_activity_events`).get().count, 0, "reset creates no activity or points");
for (const target of temporaryRecoveryTargets) {
  recoveryDb.prepare(`UPDATE ambassador_x_content_candidates SET status = 'approved' WHERE x_post_id = ?`).run(target.xPostId);
  recoveryDb.prepare(`INSERT INTO ambassador_activity_events (id, ambassador_id, kind, x_post_id, review_status) VALUES (?, ?, 'x_content', ?, 'approved')`).run(`processed-${target.xPostId}`, `amb-${target.xPostId}`, target.xPostId);
}
const repeatRecovery = resetTemporaryLostXContentCandidates(recoveryDb, recoveryNow);
assert.equal(repeatRecovery.reset.length, 0, "a repeated invocation cannot reset candidates or reprocess completed posts");
assert.equal(repeatRecovery.skipped.length, temporaryRecoveryTargets.length);
assert.equal(recoveryDb.prepare(`SELECT COUNT(*) AS count FROM ambassador_activity_events`).get().count, temporaryRecoveryTargets.length, "repeated recovery does not duplicate processed activities");
recoveryDb.close();

const unlistedDb = createTemporaryRecoveryDatabase();
unlistedDb.prepare(`INSERT INTO ambassador_x_content_candidates (x_post_id, author_id, discovery_source, status, rejection_reason, discovered_at, created_at, updated_at) VALUES ('9999999999999999999', 'unlisted-author', 'filtered_stream', 'rejected', 'automatic_retry_exhausted', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`).run();
const unlistedResult = resetTemporaryLostXContentCandidates(unlistedDb, recoveryNow);
assert.equal(unlistedResult.reset.length, 0, "unlisted post IDs are never reset");
assert.equal(unlistedDb.prepare(`SELECT status FROM ambassador_x_content_candidates WHERE x_post_id = '9999999999999999999'`).get().status, "rejected");
unlistedDb.close();

for (const scenario of [
  { label: "wrong author", overrides: { authorId: "wrong-author" }, reason: "author_id_mismatch" },
  { label: "unapproved Ambassador", overrides: { ambassadorStatus: "pending" }, reason: "ambassador_not_approved" },
  { label: "existing X activity", overrides: { activity: true }, reason: "activity_exists" },
  { label: "mismatched Ambassador X user ID", overrides: { ambassadorXUserId: "different-author" }, reason: "ambassador_not_approved" },
  { label: "wrong discovery source", overrides: { discoverySource: "recent_search" }, reason: "historical_candidate_mismatch" },
  { label: "wrong discovered timestamp", overrides: { discoveredAt: "2026-09-28T00:00:00.000Z" }, reason: "historical_candidate_mismatch" },
  { label: "wrong rejection reason", overrides: { rejectionReason: "automatic_retry_exhausted" }, reason: "rejection_reason_mismatch" },
  { label: "candidate no longer rejected", overrides: { status: "approved" }, reason: "candidate_not_rejected" },
]) {
  const db = createTemporaryRecoveryDatabase();
  insertTemporaryRecoveryTarget(db, temporaryRecoveryTargets[0], scenario.overrides);
  const result = resetTemporaryLostXContentCandidates(db, recoveryNow);
  assert.ok(result.skipped.some((entry) => entry.xPostId === temporaryRecoveryTargets[0].xPostId && entry.reason === scenario.reason), `${scenario.label} prevents recovery reset`);
  assert.equal(result.reset.includes(temporaryRecoveryTargets[0].xPostId), false);
  db.close();
}

posts.set("10001", post("10001"));
assert.equal((await processor.processPostId("10001", "filtered_stream")).status, "approved", "a verified Ambassador post should be awarded");
assert.equal(awards.length, 1);
assert.equal(awards[0].xImpressions, 999, "impressions must come from the authoritative X response");
assert.equal(awards[0].xQualityScore, 80, "quality comes from the server-side evaluator");
assert.equal((await processor.processPostId("10001", "recent_search")).status, "duplicate", "repeated stream/recovery delivery cannot award twice");
assert.equal(awards.length, 1);
assert.equal(calculateXContentPoints(0, 0), 100, "quality zero still receives the base points");
assert.equal(calculateXContentPoints(50, 1000), 210);
assert.equal(calculateXContentPoints(60, 565), 225);
assert.equal(calculateXContentPoints(0, 199), 101, "impressions use floor(impressions / 100)");
assert.equal(calculateXContentPoints(100, 100_000), 1300);
assert.equal(calculateXContentPoints(-10, 0), 100, "quality is clamped at zero");
assert.equal(calculateXContentPoints(120, 0), 300, "quality is clamped at 100");
database.prepare(`INSERT INTO ambassador_x_content_candidates (x_post_id, author_id, discovery_source, status, discovered_at, created_at, updated_at) VALUES ('10017', 'user-1', 'filtered_stream', 'processing', ?, ?, ?)`)
  .run(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), new Date(now.getTime() - 60 * 60 * 1000).toISOString(), new Date(now.getTime() - 60 * 60 * 1000).toISOString());
posts.set("10017", post("10017", { text: "Dust Engine made wallet dust cleanup clearer after a stream worker restart." }));
assert.equal((await processor.processPostId("10017", "recent_search")).status, "approved", "stale processing claims are recoverable after a worker restart");
const callsBeforeRecovery = getPostCalls;
assert.equal((await processor.processRecoveredPost(post("10015", { text: "Dust Engine helped me compare tiny wallet balances without any manual submission.", impressions: 321 }))).status, "approved", "Recent Search recovery can award a qualifying post");
assert.equal(getPostCalls, callsBeforeRecovery, "Recent Search recovery uses the authoritative recovered X payload without an extra lookup");

posts.set("10002", post("10002", { authorId: "unknown" }));
assert.equal((await processor.processPostId("10002", "filtered_stream")).status, "rejected", "unknown X authors are rejected");
posts.set("10003", post("10003", { authorId: "user-2" }));
assert.equal((await processor.processPostId("10003", "filtered_stream")).status, "rejected", "unapproved Ambassadors are rejected");
database.prepare(`INSERT INTO ambassador_x_content_candidates (x_post_id, author_id, discovery_source, status, discovered_at, created_at, updated_at) VALUES ('10013', 'different-user', 'filtered_stream', 'evaluation_failed', ?, ?, ?)`)
  .run(now.toISOString(), now.toISOString(), now.toISOString());
posts.set("10013", post("10013"));
assert.equal((await processor.processPostId("10013", "filtered_stream")).reason, "author_mismatch", "a conflicting stored author is rejected");
posts.set("10004", post("10004", { isRepost: true }));
assert.equal((await processor.processPostId("10004", "filtered_stream")).reason, "repost_without_original_commentary");
posts.set("10005", post("10005", { text: "This is exactly what I needed for my Base wallet.", referencedText: "Dust Engine makes wallet dust cleanup easier.", isQuote: true }));
assert.equal((await processor.processPostId("10005", "filtered_stream")).status, "approved", "meaningful quote commentary can qualify");
posts.set("10016", post("10016", { text: "https://x.com/DustEngine/status/1", referencedText: "Dust Engine makes wallet dust cleanup easier.", isQuote: true }));
assert.equal((await processor.processPostId("10016", "filtered_stream")).reason, "quote_without_meaningful_commentary", "empty quote commentary is rejected");
for (const [id, text] of [["10029", "ok"], ["10030", "nice"], ["10031", "nice work"]] as const) {
  posts.set(id, post(id, { text, referencedText: "Dust Engine makes wallet dust cleanup easier.", isQuote: true }));
  const result = await processor.processPostId(id, "filtered_stream");
  assert.deepEqual(result, { status: "rejected", reason: "quote_without_meaningful_commentary" }, `trivial quote commentary '${text}' is rejected`);
  assert.equal(database.prepare(`SELECT 1 FROM ambassador_activity_events WHERE x_post_id = ?`).get(id), undefined);
}
posts.set("10032", post("10032", { text: "@DustEngine saved me time.", referencedText: "Dust Engine makes wallet dust cleanup easier.", isQuote: true }));
assert.equal((await processor.processPostId("10032", "filtered_stream")).status, "approved", "short informative quote commentary qualifies");
for (const [id, text] of [["10027", "@DustEngine"], ["10028", "@dustengineapp"]] as const) {
  posts.set(id, post(id, { text }));
  const result = await processor.processPostId(id, "filtered_stream");
  assert.deepEqual(result, { status: "rejected", reason: "empty_dust_engine_mention" }, "a pure Dust Engine tag is rejected without points");
  assert.equal(database.prepare(`SELECT 1 FROM ambassador_activity_events WHERE x_post_id = ?`).get(id), undefined);
}
posts.set("10006", post("10006", { text: "Dust Engine airdrop guaranteed profit!!!" }));
assert.equal((await processor.processPostId("10006", "filtered_stream")).reason, "obvious_spam");
assert.equal(database.prepare(`SELECT status FROM ambassador_x_content_candidates WHERE x_post_id = '10006'`).get().status, "rejected", "deterministic spam remains a permanent content rejection");

posts.set("10007", post("10007", { text: "Dust Engine helps people find wallet dust, makes Base cleanup easier, and keeps the process straightforward." }));
assert.equal((await processor.processPostId("10007", "filtered_stream")).status, "approved");
posts.set("10008", post("10008", { text: "Dust Engine helps people find wallet dust, makes Base cleanup simpler, and keeps the process straightforward." }));
assert.equal((await processor.processPostId("10008", "filtered_stream")).reason, "near_duplicate_content", "copy-paste farming is rejected");

evaluation = { ...highQuality, eligible: false, relevance: 10, qualityScore: 0 };
posts.set("10009", post("10009", { text: "Dust Engine is useful for my wallet cleanup experience.", impressions: 0 }));
const lowQualityResult = await processor.processPostId("10009", "filtered_stream");
assert.equal(lowQualityResult.status, "approved", "genuine qualifying content is not rejected for low quality or evaluator relevance/eligibility fields");
assert.equal(lowQualityResult.points, 100, "quality zero earns the base points");
const lowQualityActivity = database.prepare(`SELECT status, review_status, x_quality_score FROM ambassador_x_content_candidates JOIN ambassador_activity_events USING (x_post_id) WHERE x_post_id = '10009'`).get() as { status: string; review_status: string; x_quality_score: number };
assert.deepEqual(lowQualityActivity, { status: "approved", review_status: "approved", x_quality_score: 0 });
evaluation = { ...highQuality, qualityScore: 60 };
posts.set("10010", post("10010", { text: "Dust Engine helped me compare small Base balances after a weekend wallet cleanup.", impressions: 565 }));
const formulaResult = await processor.processPostId("10010", "filtered_stream");
assert.equal(formulaResult.points, 225, "processor applies quality × 2 and floor(impressions / 100)");
assert.equal(calculateXContentPoints(60, 565), 225);
assert.equal(database.prepare(`SELECT review_status FROM ambassador_activity_events WHERE x_post_id = '10010'`).get().review_status, "approved");
evaluation = { ...highQuality, eligible: false, relevance: 10, qualityScore: 0 };
posts.set("10033", post("10033", { text: "@DustEngine This made my Base cleanup easier and saved me time.", referencedText: "Dust Engine makes wallet dust cleanup easier.", isQuote: true, impressions: 0 }));
const lowQualityQuoteResult = await processor.processPostId("10033", "filtered_stream");
assert.equal(lowQualityQuoteResult.status, "approved", "meaningful quote commentary qualifies regardless of low quality");
assert.equal(lowQualityQuoteResult.points, 100);
assert.equal((database.prepare(`SELECT review_status, x_quality_score FROM ambassador_activity_events WHERE x_post_id = '10033'`).get() as { review_status: string; x_quality_score: number }).x_quality_score, 0);
evaluation = highQuality;

evaluation = { ...highQuality, spamLikelihood: 60 };
posts.set("10026", post("10026", { text: "Dust Engine is a genuine topic but this post matches spam signals." }));
assert.equal((await processor.processPostId("10026", "filtered_stream")).reason, "spam_likelihood", "the evaluator spam safeguard remains active");
evaluation = highQuality;

const malformedResponse = (() => {
  try {
    parseXContentEvaluationText("not-json");
  } catch (error) {
    return error;
  }
  throw new Error("Malformed evaluator JSON should be retryable");
})();
assert.ok(malformedResponse instanceof RetryableQualityError);
assert.equal(malformedResponse.diagnostic.category, "malformed_response");
evaluationFailure = malformedResponse;
posts.set("10014", post("10014", { text: "Dust Engine helped me understand my token balances far better." }));
assert.equal((await processor.processPostId("10014", "filtered_stream")).status, "deferred", "malformed Gemini output is retryable");
const malformedCandidate = database.prepare(`SELECT status, last_error, rejection_reason FROM ambassador_x_content_candidates WHERE x_post_id = '10014'`).get() as { status: string; last_error: string; rejection_reason: string | null };
assert.equal(malformedCandidate.status, "evaluation_failed");
assert.equal(JSON.parse(malformedCandidate.last_error).category, "malformed_response");
assert.equal(malformedCandidate.rejection_reason, null);
evaluationFailure = null;
evaluation = highQuality;

const providerFailure = classifyGeminiProviderFailure(Object.assign(
  new Error('API_KEY=AIza123456789012345678901234567890 Authorization: Bearer private-token https://user:password@example.test/path {"error":{"message":"response body marker"},"payload":"PRIVATE_PROMPT_PAYLOAD_MARKER"}'),
  {
    status: 429,
    code: "RESOURCE_EXHAUSTED",
    response: { data: { authorization: "Bearer response-token", url: "https://key:secret@example.test", payload: "PRIVATE_RESPONSE_PAYLOAD_MARKER" } },
  },
));
assert.equal(providerFailure.diagnostic.category, "provider_api_error");
assert.equal(providerFailure.diagnostic.diagnosticClass, "provider_api_failure");
assert.equal(providerFailure.diagnostic.httpStatus, 429);
assert.equal(providerFailure.diagnostic.providerCode, "RESOURCE_EXHAUSTED");
assert.equal(providerFailure.message, "Gemini evaluation temporarily failed", "the candidate-facing provider error remains concise and stable");
assert.deepEqual(Object.keys(providerFailure.diagnostic).sort(), ["category", "diagnosticClass", "httpStatus", "providerCode"]);
evaluationFailure = providerFailure;
posts.set("10024", post("10024", { text: "Dust Engine made it much easier to clean up forgotten tokens on Base." }));
const originalWarn = console.warn;
let capturedDiagnosticLog = "";
console.warn = (...args: unknown[]) => { capturedDiagnosticLog = JSON.stringify(args); };
let providerResult: ProcessResult | undefined;
try {
  providerResult = await processor.processPostId("10024", "filtered_stream");
} finally {
  console.warn = originalWarn;
}
assert.equal(providerResult.status, "deferred", "provider failures remain retryable");
const providerCandidate = database.prepare(`SELECT status, retry_count, next_retry_at, last_error, rejection_reason FROM ambassador_x_content_candidates WHERE x_post_id = '10024'`).get() as { status: string; retry_count: number; next_retry_at: string; last_error: string; rejection_reason: string | null };
const providerDiagnostic = JSON.parse(providerCandidate.last_error);
assert.equal(providerCandidate.status, "evaluation_failed");
assert.equal(providerCandidate.retry_count, 1);
assert.equal(Date.parse(providerCandidate.next_retry_at) - now.getTime(), 60_000, "first fast retry remains delayed by one minute");
assert.equal(providerDiagnostic.category, "provider_api_error");
assert.equal(providerDiagnostic.httpStatus, 429);
assert.equal(providerDiagnostic.providerCode, "RESOURCE_EXHAUSTED");
assert.equal(providerDiagnostic.retryAttempt, 1);
assert.deepEqual(Object.keys(providerDiagnostic).sort(), ["category", "diagnosticClass", "httpStatus", "providerCode", "retryAttempt"]);
assert.equal(providerCandidate.rejection_reason, null);
for (const sensitiveValue of ["AIza123456789012345678901234567890", "private-token", "response-token", "PRIVATE_PROMPT_PAYLOAD_MARKER", "PRIVATE_RESPONSE_PAYLOAD_MARKER", "user:password", "key:secret", "response body marker"]) {
  assert.equal(providerCandidate.last_error.includes(sensitiveValue), false, `persisted diagnostics exclude ${sensitiveValue}`);
  assert.equal(capturedDiagnosticLog.includes(sensitiveValue), false, `server logs exclude ${sensitiveValue}`);
}
evaluationFailure = null;

// Exhaust the bounded fast retries, then verify recovery continues on a slow,
// bounded schedule instead of permanently rejecting the candidate.
evaluationFailure = classifyGeminiProviderFailure({ status: 503, code: "UNAVAILABLE", message: "temporary provider outage" });
posts.set("10025", post("10025", { text: "Dust Engine helped me clear forgotten token balances from Base." }));
assert.equal((await processor.processPostId("10025", "filtered_stream")).status, "deferred");
for (let attempt = 2; attempt <= 5; attempt += 1) {
  const dueAt = database.prepare(`SELECT next_retry_at FROM ambassador_x_content_candidates WHERE x_post_id = '10025'`).get() as { next_retry_at: string };
  now = new Date(dueAt.next_retry_at);
  assert.equal((await processor.processPostId("10025", "automatic_retry")).status, "deferred");
  const row = database.prepare(`SELECT retry_count, status FROM ambassador_x_content_candidates WHERE x_post_id = '10025'`).get() as { retry_count: number; status: string };
  assert.equal(row.retry_count, attempt);
  assert.equal(row.status, "evaluation_failed");
}
let exhaustedFast = database.prepare(`SELECT retry_count, next_retry_at, status, rejection_reason FROM ambassador_x_content_candidates WHERE x_post_id = '10025'`).get() as { retry_count: number; next_retry_at: string; status: string; rejection_reason: string | null };
assert.equal(exhaustedFast.retry_count, 5);
now = new Date(exhaustedFast.next_retry_at);
assert.equal((await processor.processPostId("10025", "automatic_retry")).status, "deferred");
let slowRetry = database.prepare(`SELECT retry_count, next_retry_at, status, rejection_reason FROM ambassador_x_content_candidates WHERE x_post_id = '10025'`).get() as { retry_count: number; next_retry_at: string; status: string; rejection_reason: string | null };
assert.equal(slowRetry.retry_count, 6);
assert.equal(Date.parse(slowRetry.next_retry_at) - now.getTime(), 24 * 60 * 60 * 1000, "the first retry after five fast attempts waits 24 hours");
assert.equal(slowRetry.status, "evaluation_failed");
assert.equal(slowRetry.rejection_reason, null, "exhausted transient retries are not content rejections");
now = new Date(slowRetry.next_retry_at);
assert.equal((await processor.processPostId("10025", "automatic_retry")).status, "deferred");
slowRetry = database.prepare(`SELECT retry_count, next_retry_at, status, rejection_reason FROM ambassador_x_content_candidates WHERE x_post_id = '10025'`).get() as { retry_count: number; next_retry_at: string; status: string; rejection_reason: string | null };
assert.equal(Date.parse(slowRetry.next_retry_at) - now.getTime(), 48 * 60 * 60 * 1000, "slow retry backoff doubles and remains controlled");
evaluationFailure = null;

// A newly verified exact X author may re-enter the ordinary validation path.
posts.set("10020", post("10020", { authorId: "late-verified-user", text: "Dust Engine helped me rescue overlooked Base network tokens after I reviewed my address history." }));
assert.equal((await processor.processPostId("10020", "filtered_stream")).reason, "unverified_or_unapproved_author");
insertAmbassador.run("ambassador-late", "late-verified-user");
assert.equal(requeueCandidatesForVerifiedAuthor(database, "late-verified-user", now), 1);
const requeuedCandidate = database.prepare(`SELECT status, retry_count, rejection_reason FROM ambassador_x_content_candidates WHERE x_post_id = '10020'`).get() as { status: string; retry_count: number; rejection_reason: string | null };
assert.deepEqual(requeuedCandidate, { status: "evaluation_failed", retry_count: 0, rejection_reason: null });
assert.equal((await processor.processPostId("10020", "automatic_retry")).status, "approved", "requeued candidates pass through normal validation and evaluation");

posts.set("10021", post("10021", { authorId: "different-late-user" }));
assert.equal((await processor.processPostId("10021", "filtered_stream")).reason, "unverified_or_unapproved_author");
insertAmbassador.run("ambassador-other-late", "verified-other-user");
assert.equal(requeueCandidatesForVerifiedAuthor(database, "verified-other-user", now), 0, "a different X author is never requeued");
assert.equal(database.prepare(`SELECT status FROM ambassador_x_content_candidates WHERE x_post_id = '10021'`).get().status, "rejected");

posts.set("10022", post("10022", { authorId: "already-awarded-user" }));
assert.equal((await processor.processPostId("10022", "filtered_stream")).reason, "unverified_or_unapproved_author");
insertAmbassador.run("ambassador-already-awarded", "already-awarded-user");
database.prepare(`INSERT INTO ambassador_activity_events (id, ambassador_id, kind, x_post_id, x_user_id, x_impressions, x_quality_score, review_status) VALUES ('existing-10022', 'ambassador-already-awarded', 'x_content', '10022', 'already-awarded-user', 1, 80, 'approved')`).run();
assert.equal(requeueCandidatesForVerifiedAuthor(database, "already-awarded-user", now), 0, "existing X activity prevents requeue");
assert.equal(database.prepare(`SELECT status FROM ambassador_x_content_candidates WHERE x_post_id = '10022'`).get().status, "rejected");

forcedDuplicateIds.add("10023");
posts.set("10023", post("10023", { text: "Dust Engine clarified the long tail of inactive Base assets while I audited my older wallet activity." }));
assert.equal((await processor.processPostId("10023", "filtered_stream")).reason, "post_already_awarded", "the final activity persistence duplicate guard remains authoritative");
assert.equal(database.prepare(`SELECT status FROM ambassador_x_content_candidates WHERE x_post_id = '10023'`).get().status, "rejected");
assert.equal(awards.some((award) => award.xPostId === "10023"), false, "a duplicate response never increments rewards");
forcedDuplicateIds.delete("10023");

evaluationFailure = new RetryableQualityError("temporary Gemini outage");
posts.set("10011", post("10011", { text: "Dust Engine gave me a much clearer way to clean up forgotten Base tokens." }));
assert.equal((await processor.processPostId("10011", "filtered_stream")).status, "deferred", "temporary Gemini failures are retryable");
evaluationFailure = null;
now = new Date(now.getTime() + 61_000);
await processor.retryDueCandidates();
assert.equal(database.prepare(`SELECT status FROM ambassador_x_content_candidates WHERE x_post_id = '10011'`).get().status, "approved", "retry succeeds automatically");

failures.set("10012", new Error("temporary X API failure"));
assert.equal((await processor.processPostId("10012", "filtered_stream")).status, "deferred", "temporary X failures are retryable");
failures.delete("10012");
posts.set("10012", post("10012", { text: "Dust Engine made it easy to understand which wallet balances were actually dust." }));
now = new Date(now.getTime() + 61_000);
await processor.retryDueCandidates();
assert.equal(database.prepare(`SELECT status FROM ambassador_x_content_candidates WHERE x_post_id = '10012'`).get().status, "approved", "recovery retry uses authoritative X data");

// Discovery remains one global query regardless of the number of verified
// Ambassadors; no user timeline or per-Ambassador request is available here.
database.transaction(() => {
  for (let index = 3; index <= 5_000; index += 1) insertAmbassador.run(`ambassador-${index}`, `user-${index}`);
})();
const globalSearchStarts: string[] = [];
const globalClient = {
  getPost: async () => null,
  syncRules: async () => undefined,
  stream: async () => undefined,
  recentSearch: async (startTime: string) => {
    globalSearchStarts.push(startTime);
    return [post("10018", { text: "Dust Engine gave me a clear, practical way to clean the small tokens in my Base wallet.", impressions: 555 })];
  },
};
const worker = new XContentWorker({ db: database, client: globalClient, processor, recoveryIntervalMs: DEFAULT_X_CONTENT_RECOVERY_INTERVAL_MS, now: () => now });
const firstRecoveryStart = new Date(now.getTime() - DEFAULT_X_CONTENT_RECOVERY_INTERVAL_MS - X_CONTENT_RECOVERY_OVERLAP_MS).toISOString();
assert.equal(recoverySearchStart(now), firstRecoveryStart, "a first recovery covers the prior daily window plus overlap");
await worker.recoverOnce();
assert.deepEqual(globalSearchStarts, [firstRecoveryStart], "5,000 Ambassadors still use one global discovery request");
assert.equal((await worker.recoverOnce()), undefined, "a persisted checkpoint suppresses an unnecessary restart search");
assert.equal(globalSearchStarts.length, 1);
assert.ok(awards.some((award) => award.xPostId === "10018"), "a globally discovered verified Ambassador post reaches the existing reward pipeline");
const checkpoint = now;
now = new Date(now.getTime() + DEFAULT_X_CONTENT_RECOVERY_INTERVAL_MS);
await worker.recoverOnce();
assert.equal(globalSearchStarts[1], new Date(checkpoint.getTime() - X_CONTENT_RECOVERY_OVERLAP_MS).toISOString(), "daily recovery searches from the persisted checkpoint with a safe overlap");
assert.equal(DEFAULT_X_CONTENT_RECOVERY_INTERVAL_MS, 24 * 60 * 60 * 1000, "global discovery cadence is once per 24 hours");

await assert.rejects(() => evaluateXContent({ content: "Dust Engine", apiKey: undefined }), RetryableQualityError, "missing Gemini configuration fails safely");
for (const signal of ["Dust Engine", "@DustEngine", "@dustengineapp", "dustengine.xyz", "https://dustengine.xyz/", "#DustEngine", "dustengine"]) assert.equal(hasDiscoverySignal(signal), true, `discovery signal ${signal} should match`);
for (const term of ['"Dust Engine"', "@DustEngine", "dustengine.xyz", "#DustEngine", "@dustengineapp", '"https://dustengine.xyz/"', "dustengine"]) assert.ok(X_DISCOVERY_RULE.includes(term), `global discovery rule retains ${term}`);
assert.equal(hasDiscoverySignal("unrelated wallet app"), false);
assert.equal(awards.every((award) => !("points" in award) && !Object.prototype.hasOwnProperty.call(award, "browserQuality")), true, "the processor accepts no browser-controlled points or scores");

database.close();
console.log("Ambassador X-content tests passed");
