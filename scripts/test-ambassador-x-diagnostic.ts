import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { isAmbassadorAdminTokenAuthorized, readAmbassadorXDiagnostic, X_DIAGNOSTIC_POST_IDS, X_DIAGNOSTIC_USERNAMES } from "../server/ambassadorXDiagnostic.js";

assert.equal(isAmbassadorAdminTokenAuthorized(undefined, "token"), false);
assert.equal(isAmbassadorAdminTokenAuthorized("secret", undefined), false);
assert.equal(isAmbassadorAdminTokenAuthorized("secret", "wrong"), false);
assert.equal(isAmbassadorAdminTokenAuthorized("secret", "secret"), true);

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE ambassadors (
    id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    x_user_id TEXT,
    x_username TEXT,
    x_handle TEXT,
    status TEXT NOT NULL
  );
  CREATE TABLE ambassador_x_content_candidates (
    x_post_id TEXT PRIMARY KEY,
    author_id TEXT,
    discovery_source TEXT,
    status TEXT,
    retry_count INTEGER,
    next_retry_at TEXT,
    last_error TEXT,
    rejection_reason TEXT,
    evaluation_json TEXT,
    discovered_at TEXT,
    processed_at TEXT
  );
  CREATE TABLE ambassador_activity_events (
    id TEXT PRIMARY KEY,
    ambassador_id TEXT,
    kind TEXT,
    x_post_id TEXT,
    x_user_id TEXT,
    x_quality_score REAL,
    x_impressions INTEGER,
    review_status TEXT,
    completed_at TEXT
  );
  CREATE TABLE ambassador_x_content_runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
  INSERT INTO ambassadors VALUES ('amb-1', '0x1111111111111111111111111111111111111111', 'user-1', 'thecryptobankr', '@thecryptobankr', 'approved');
  INSERT INTO ambassadors VALUES ('amb-2', '0x2222222222222222222222222222222222222222', 'user-2', 'supergirlheena', '@supergirlheena', 'approved');
  INSERT INTO ambassadors VALUES ('amb-3', '0x3333333333333333333333333333333333333333', 'user-3', 'NoirChemistry', '@NoirChemistry', 'inactive');
  INSERT INTO ambassadors VALUES ('unrelated', '0x4444444444444444444444444444444444444444', 'user-4', 'someoneelse', '@someoneelse', 'approved');
  INSERT INTO ambassador_x_content_candidates VALUES ('2104131232456221005', 'user-1', 'recent_search', 'approved', 0, NULL, NULL, NULL, '{"qualityScore":80}', '2026-09-30T00:00:00.000Z', '2026-09-30T00:01:00.000Z');
  INSERT INTO ambassador_x_content_candidates VALUES ('9999999999999999999', 'user-4', 'filtered_stream', 'rejected', 0, NULL, NULL, 'unrelated', NULL, '2026-09-30T00:00:00.000Z', NULL);
  INSERT INTO ambassador_activity_events VALUES ('activity-1', 'amb-1', 'x_content', '2104131232456221005', 'user-1', 80, 500, 'approved', '2026-09-30T00:01:00.000Z');
  INSERT INTO ambassador_activity_events VALUES ('activity-unrelated', 'unrelated', 'x_content', '9999999999999999999', 'user-4', 90, 900, 'approved', '2026-09-30T00:01:00.000Z');
  INSERT INTO ambassador_x_content_runtime_state VALUES ('last_recovery_at', '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
  INSERT INTO ambassador_x_content_runtime_state VALUES ('bearer_token', 'must-not-be-returned', '2026-09-30T00:00:00.000Z');
`);

const diagnostic = readAmbassadorXDiagnostic(db, {
  automaticDiscoveryEnabled: true,
  geminiEvaluationConfigured: false,
});
assert.deepEqual(diagnostic.posts.map((post) => post.x_post_id), [...X_DIAGNOSTIC_POST_IDS]);
assert.equal(diagnostic.posts[0]?.candidate.exists, true);
assert.equal(diagnostic.posts[0]?.candidate.row?.author_id, "user-1");
assert.equal(diagnostic.posts[0]?.authorAmbassador.row?.ambassador_id, "amb-1");
assert.equal(diagnostic.posts[0]?.activities.rows.length, 1);
assert.equal(diagnostic.posts[0]?.activities.rows[0]?.created_at, null, "created_at is explicitly unavailable when schema stores completed_at only");
assert.deepEqual(diagnostic.posts.slice(1).map((post) => [post.candidate.exists, post.activities.exists]), [[false, false], [false, false]]);
assert.deepEqual(diagnostic.ambassadors.map((row) => row.requested_username), [...X_DIAGNOSTIC_USERNAMES]);
assert.equal(diagnostic.ambassadors[2]?.row?.status, "inactive");
assert.equal(diagnostic.configuration.automaticDiscovery, "enabled");
assert.equal(diagnostic.configuration.geminiEvaluation, "not_configured");
assert.deepEqual(diagnostic.runtimeState.last_recovery_at, {
  status: "available",
  value: "2026-09-30T00:00:00.000Z",
  updated_at: "2026-09-30T00:00:00.000Z",
});
assert.deepEqual(diagnostic.runtimeState.otherSafeFields, []);
assert.doesNotMatch(JSON.stringify(diagnostic), /must-not-be-returned|unrelated/);

db.close();
console.log("Ambassador X diagnostic tests passed");
