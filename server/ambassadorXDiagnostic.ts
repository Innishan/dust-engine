export const X_DIAGNOSTIC_POST_IDS = [
  "2104131232456221005",
  "2104114823906906298",
  "2104136133391405229",
] as const;

export const X_DIAGNOSTIC_USERNAMES = [
  "thecryptobankr",
  "supergirlheena",
  "NoirChemistry",
] as const;

const SAFE_RUNTIME_KEYS = ["last_recovery_at"] as const;

type SqliteDatabase = {
  prepare: (query: string) => {
    all: (...params: unknown[]) => any[];
    get: (...params: unknown[]) => any;
  };
};

function publicIdentity(identity: Record<string, unknown> | null) {
  if (!identity) return null;
  return {
    ambassador_id: identity.ambassador_id,
    wallet_address: identity.wallet_address,
    x_user_id: identity.x_user_id,
    x_username: identity.x_username,
    status: identity.status,
  };
}

export function isAmbassadorAdminTokenAuthorized(configuredToken: string | undefined, suppliedToken: string | undefined) {
  return Boolean(configuredToken && suppliedToken === configuredToken);
}

export function readAmbassadorXDiagnostic(db: SqliteDatabase, configuration: {
  automaticDiscoveryEnabled: boolean;
  geminiEvaluationConfigured: boolean;
}) {
  const placeholders = X_DIAGNOSTIC_POST_IDS.map(() => "?").join(", ");
  const candidateRows = db.prepare(`
    SELECT x_post_id, author_id, discovery_source, status, retry_count, next_retry_at,
      last_error, rejection_reason, evaluation_json, discovered_at, processed_at
    FROM ambassador_x_content_candidates
    WHERE x_post_id IN (${placeholders})
  `).all(...X_DIAGNOSTIC_POST_IDS) as Array<Record<string, unknown> & { x_post_id: string; author_id: string | null }>;

  const identityPlaceholders = X_DIAGNOSTIC_USERNAMES.map(() => "?").join(", ");
  const identities = db.prepare(`
    SELECT id AS ambassador_id, wallet_address, x_user_id, x_username, x_handle, status
    FROM ambassadors
    WHERE lower(ltrim(COALESCE(x_username, ''), '@')) IN (${identityPlaceholders})
       OR lower(ltrim(COALESCE(x_handle, ''), '@')) IN (${identityPlaceholders})
  `).all(...X_DIAGNOSTIC_USERNAMES.map((username) => username.toLowerCase()), ...X_DIAGNOSTIC_USERNAMES.map((username) => username.toLowerCase())) as Array<Record<string, unknown> & { x_username: string | null; x_handle: string | null; x_user_id: string | null }>;

  const identityForUsername = (username: string) => identities.find((identity) =>
    (identity.x_username || "").replace(/^@/, "").toLowerCase() === username.toLowerCase()
    || (identity.x_handle || "").replace(/^@/, "").toLowerCase() === username.toLowerCase(),
  );
  const candidateByPostId = new Map(candidateRows.map((row) => [row.x_post_id, row]));
  const activityColumns = db.prepare("PRAGMA table_info(ambassador_activity_events)").all() as Array<{ name: string }>;
  const createdAtSelection = activityColumns.some((column) => column.name === "created_at") ? "created_at" : "NULL AS created_at";
  const activityRows = db.prepare(`
    SELECT ambassador_id, kind, x_post_id, x_user_id, x_quality_score, x_impressions,
      review_status, ${createdAtSelection}, completed_at
    FROM ambassador_activity_events
    WHERE x_post_id IN (${placeholders})
    ORDER BY x_post_id, completed_at
  `).all(...X_DIAGNOSTIC_POST_IDS) as Array<Record<string, unknown> & { x_post_id: string; x_user_id: string | null }>;
  const activityByPostId = new Map<string, typeof activityRows>();
  for (const row of activityRows) activityByPostId.set(row.x_post_id, [...(activityByPostId.get(row.x_post_id) || []), row]);

  const runtimeRows = db.prepare(`
    SELECT key, value, updated_at
    FROM ambassador_x_content_runtime_state
    WHERE key IN (${SAFE_RUNTIME_KEYS.map(() => "?").join(", ")})
  `).all(...SAFE_RUNTIME_KEYS);
  const lastRecovery = runtimeRows.find((row: { key: string }) => row.key === "last_recovery_at") as { value: string; updated_at: string } | undefined;

  return {
    posts: X_DIAGNOSTIC_POST_IDS.map((postId) => {
      const candidate = candidateByPostId.get(postId) || null;
      const matchedIdentity = candidate?.author_id
        ? identities.find((identity) => identity.x_user_id === candidate.author_id) || null
        : null;
      const activity = activityByPostId.get(postId) || [];
      return {
        x_post_id: postId,
        candidate: { exists: Boolean(candidate), row: candidate },
        authorAmbassador: { exists: Boolean(matchedIdentity), row: publicIdentity(matchedIdentity) },
        activities: { exists: activity.length > 0, rows: activity },
      };
    }),
    ambassadors: X_DIAGNOSTIC_USERNAMES.map((username) => {
      const row = identityForUsername(username) || null;
      return { requested_username: username, exists: Boolean(row), row: publicIdentity(row) };
    }),
    runtimeState: {
      last_recovery_at: {
        status: lastRecovery ? "available" : "not_recorded",
        value: lastRecovery?.value ?? null,
        updated_at: lastRecovery?.updated_at ?? null,
      },
      otherSafeFields: [],
    },
    configuration: {
      automaticDiscovery: configuration.automaticDiscoveryEnabled ? "enabled" : "disabled",
      geminiEvaluation: configuration.geminiEvaluationConfigured ? "configured" : "not_configured",
    },
  };
}
