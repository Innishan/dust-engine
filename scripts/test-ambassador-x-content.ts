import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { evaluateXContent, RetryableQualityError, type XContentEvaluation } from "../server/ambassadorXQuality";
import { XContentProcessor, calculateXContentPoints, hasDiscoverySignal, initializeXContentTables, type XPost } from "../server/ambassadorXContent";

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
const awards: Array<Record<string, unknown>> = [];
let getPostCalls = 0;

const processor = new XContentProcessor({
  db: database,
  client: { getPost: async (id) => { getPostCalls += 1; const failure = failures.get(id); if (failure) throw failure; return posts.get(id) || null; } },
  evaluate: async () => { if (evaluationFailure) throw evaluationFailure; return evaluation; },
  qualityThreshold: 40,
  now: () => now,
  recordApprovedActivity: (activity) => {
    assert.equal(activity.kind, "x_content", "approved X posts must be persisted as X-content activity");
    assert.equal(Object.prototype.hasOwnProperty.call(activity, "points"), false, "points are never accepted from caller input");
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

posts.set("10001", post("10001"));
assert.equal((await processor.processPostId("10001", "filtered_stream")).status, "approved", "a verified Ambassador post should be awarded");
assert.equal(awards.length, 1);
assert.equal(awards[0].xImpressions, 999, "impressions must come from the authoritative X response");
assert.equal(awards[0].xQualityScore, 80, "quality comes from the server-side evaluator");
assert.equal((await processor.processPostId("10001", "recent_search")).status, "duplicate", "repeated stream/recovery delivery cannot award twice");
assert.equal(awards.length, 1);
assert.equal(calculateXContentPoints(80, 999), 800, "server scoring formula remains unchanged");
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
posts.set("10006", post("10006", { text: "Dust Engine airdrop guaranteed profit!!!" }));
assert.equal((await processor.processPostId("10006", "filtered_stream")).reason, "obvious_spam");

posts.set("10007", post("10007", { text: "Dust Engine helps people find wallet dust, makes Base cleanup easier, and keeps the process straightforward." }));
assert.equal((await processor.processPostId("10007", "filtered_stream")).status, "approved");
posts.set("10008", post("10008", { text: "Dust Engine helps people find wallet dust, makes Base cleanup simpler, and keeps the process straightforward." }));
assert.equal((await processor.processPostId("10008", "filtered_stream")).reason, "near_duplicate_content", "copy-paste farming is rejected");

evaluation = { ...highQuality, qualityScore: 39 };
posts.set("10009", post("10009", { text: "Dust Engine is useful for my wallet cleanup experience." }));
assert.equal((await processor.processPostId("10009", "filtered_stream")).reason, "below_quality_threshold");
evaluation = { ...highQuality, relevance: 10, eligible: false, qualityScore: 90 };
posts.set("10010", post("10010", { text: "dustengine unrelated conversation" }));
assert.equal((await processor.processPostId("10010", "filtered_stream")).reason, "quality_evaluation_ineligible", "the broad discovery term does not grant eligibility");
evaluation = highQuality;

evaluation = {} as XContentEvaluation;
posts.set("10014", post("10014", { text: "Dust Engine helped me understand my token balances far better." }));
assert.equal((await processor.processPostId("10014", "filtered_stream")).status, "deferred", "malformed Gemini output is retryable");
evaluation = highQuality;

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

await assert.rejects(() => evaluateXContent({ content: "Dust Engine", apiKey: undefined }), RetryableQualityError, "missing Gemini configuration fails safely");
for (const signal of ["Dust Engine", "@DustEngine", "@dustengineapp", "dustengine.xyz", "https://dustengine.xyz/", "#DustEngine", "dustengine"]) assert.equal(hasDiscoverySignal(signal), true, `discovery signal ${signal} should match`);
assert.equal(hasDiscoverySignal("unrelated wallet app"), false);
assert.equal(awards.every((award) => !("points" in award) && !Object.prototype.hasOwnProperty.call(award, "browserQuality")), true, "the processor accepts no browser-controlled points or scores");

database.close();
console.log("Ambassador X-content tests passed");
