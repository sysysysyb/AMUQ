import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const authProvider = pgEnum("auth_provider", ["password", "google"]);
export const authOidcFlowMode = pgEnum("auth_oidc_flow_mode", [
  "login",
  "link",
]);
export const authTokenPurpose = pgEnum("auth_token_purpose", [
  "email_verification",
  "password_reset",
  "password_reset_session",
]);
export const authRateLimitScope = pgEnum("auth_rate_limit_scope", [
  "signup",
  "login",
  "verification_resend",
  "password_reset",
  "password_reset_resend",
]);
export const authRateLimitSubjectKind = pgEnum("auth_rate_limit_subject_kind", [
  "client_address",
  "identifier",
]);

export const authSignupAttempts = pgTable(
  "auth_signup_attempts",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenKeyId: text("token_key_id").notNull(),
    emailSubjectHash: text("email_subject_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastIssuedAt: timestamp("last_issued_at", { withTimezone: true }).notNull(),
    proofHash: text("proof_hash"),
    proofKeyId: text("proof_key_id"),
    proofIssuedAt: timestamp("proof_issued_at", { withTimezone: true }),
    proofExpiresAt: timestamp("proof_expires_at", { withTimezone: true }),
    proofConsumedAt: timestamp("proof_consumed_at", { withTimezone: true }),
  },
  (table) => [
    unique("auth_signup_attempts_token_hash_unique").on(table.tokenHash),
    unique("auth_signup_attempts_proof_hash_unique").on(table.proofHash),
    index("auth_signup_attempts_cleanup_index").on(
      table.lastIssuedAt,
      table.id,
    ),
    check(
      "auth_signup_attempts_issuance_check",
      sql`${table.lastIssuedAt} >= ${table.createdAt}`,
    ),
    check(
      "auth_signup_attempts_email_check",
      sql`${table.email} = lower(btrim(${table.email})) AND length(${table.email}) > 0`,
    ),
    check(
      "auth_signup_attempts_token_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$' AND ${table.tokenKeyId} ~ '^[0-9a-f]{16}$' AND ${table.emailSubjectHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "auth_signup_attempts_proof_check",
      sql`(${table.proofHash} IS NULL AND ${table.proofKeyId} IS NULL AND ${table.proofIssuedAt} IS NULL AND ${table.proofExpiresAt} IS NULL AND ${table.proofConsumedAt} IS NULL)
    OR (${table.proofHash} IS NOT NULL AND ${table.proofKeyId} IS NOT NULL AND ${table.proofIssuedAt} IS NOT NULL AND ${table.proofExpiresAt} IS NOT NULL
      AND ${table.proofHash} ~ '^[0-9a-f]{64}$' AND ${table.proofKeyId} ~ '^[0-9a-f]{16}$'
      AND ${table.proofIssuedAt} >= ${table.createdAt} AND ${table.proofExpiresAt} = ${table.proofIssuedAt} + interval '30 minutes'
      AND (${table.proofConsumedAt} IS NULL OR ${table.proofConsumedAt} >= ${table.proofIssuedAt}))`,
    ),
  ],
);

export const authSignupCodes = pgTable(
  "auth_signup_codes",
  {
    id: uuid().primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => authSignupAttempts.id, { onDelete: "cascade" }),
    recipient: text().notNull(),
    operationHash: text("operation_hash").notNull(),
    operationKind: text("operation_kind").notNull(),
    resendAvailableAt: timestamp("resend_available_at", {
      withTimezone: true,
    }).notNull(),
    codeDigest: text("code_digest").notNull(),
    tokenKeyId: text("token_key_id").notNull(),
    wrongAttempts: integer("wrong_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => [
    unique("auth_signup_codes_operation_hash_unique").on(table.operationHash),
    index("auth_signup_codes_attempt_index").on(
      table.attemptId,
      table.createdAt,
    ),
    index("auth_signup_codes_recipient_created_index").on(
      table.recipient,
      table.createdAt,
    ),
    check(
      "auth_signup_codes_recipient_check",
      sql`${table.recipient} = lower(btrim(${table.recipient})) AND length(${table.recipient}) > 0`,
    ),
    check(
      "auth_signup_codes_material_check",
      sql`${table.operationHash} ~ '^[0-9a-f]{64}$' AND ${table.codeDigest} ~ '^[0-9a-f]{64}$' AND ${table.tokenKeyId} ~ '^[0-9a-f]{16}$' AND ${table.operationKind} IN ('start', 'resend')`,
    ),
    check(
      "auth_signup_codes_attempts_check",
      sql`${table.wrongAttempts} BETWEEN 0 AND 5`,
    ),
    check(
      "auth_signup_codes_time_check",
      sql`${table.expiresAt} = ${table.createdAt} + interval '10 minutes' AND ${table.resendAvailableAt} >= ${table.createdAt} + interval '1 minute'
    AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt})
    AND (${table.verifiedAt} IS NULL OR (${table.verifiedAt} >= ${table.createdAt} AND ${table.verifiedAt} < ${table.expiresAt} AND ${table.revokedAt} IS NULL))`,
    ),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    emailVerifiedAt: timestamp("email_verified_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("users_email_unique").on(table.email),
    check(
      "users_email_normalized_check",
      sql`${table.email} = lower(btrim(${table.email})) AND length(${table.email}) > 0`,
    ),
  ],
);

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: authProvider().notNull(),
    providerSubject: text("provider_subject"),
    passwordHash: text("password_hash"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("auth_identities_provider_subject_unique").on(
      table.provider,
      table.providerSubject,
    ),
    unique("auth_identities_user_provider_unique").on(
      table.userId,
      table.provider,
    ),
    check(
      "auth_identities_provider_subject_check",
      sql`(${table.provider} = 'password' AND ${table.providerSubject} IS NULL) OR (${table.provider} = 'google' AND ${table.providerSubject} IS NOT NULL AND length(${table.providerSubject}) > 0)`,
    ),
    check(
      "auth_identities_password_hash_check",
      sql`(${table.provider} = 'password' AND ${table.passwordHash} IS NOT NULL) OR (${table.provider} = 'google' AND ${table.passwordHash} IS NULL)`,
    ),
  ],
);

export const authLinkSessions = pgTable(
  "auth_link_sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    primaryProvider: authProvider("primary_provider").notNull(),
    requiredProvider: authProvider("required_provider").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    unique("auth_link_sessions_token_hash_unique").on(table.tokenHash),
    index("auth_link_sessions_user_id_index").on(table.userId),
    index("auth_link_sessions_expires_at_index").on(table.expiresAt),
    check(
      "auth_link_sessions_token_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "auth_link_sessions_provider_check",
      sql`${table.primaryProvider} <> ${table.requiredProvider}`,
    ),
    check(
      "auth_link_sessions_expiry_check",
      sql`${table.createdAt} < ${table.expiresAt}`,
    ),
    check(
      "auth_link_sessions_consumed_at_check",
      sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    idleExpiresAt: timestamp("idle_expires_at", {
      withTimezone: true,
    }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", {
      withTimezone: true,
    }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("auth_sessions_token_hash_unique").on(table.tokenHash),
    index("auth_sessions_user_id_index").on(table.userId),
    index("auth_sessions_idle_expires_at_index").on(table.idleExpiresAt),
    check(
      "auth_sessions_token_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "auth_sessions_expiry_check",
      sql`${table.createdAt} <= ${table.lastSeenAt} AND ${table.lastSeenAt} < ${table.idleExpiresAt} AND ${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`,
    ),
    check(
      "auth_sessions_revoked_at_check",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: authTokenPurpose().notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    unique("auth_tokens_token_hash_unique").on(table.tokenHash),
    index("auth_tokens_user_purpose_index").on(table.userId, table.purpose),
    index("auth_tokens_expires_at_index").on(table.expiresAt),
    check(
      "auth_tokens_token_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "auth_tokens_expiry_check",
      sql`${table.createdAt} < ${table.expiresAt}`,
    ),
    check(
      "auth_tokens_consumed_at_check",
      sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const authOidcFlows = pgTable(
  "auth_oidc_flows",
  {
    id: uuid().primaryKey().defaultRandom(),
    flowHash: text("flow_hash").notNull(),
    stateHash: text("state_hash").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    mode: authOidcFlowMode().notNull(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    sessionTokenHash: text("session_token_hash"),
    returnTo: text("return_to").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    unique("auth_oidc_flows_flow_hash_unique").on(table.flowHash),
    unique("auth_oidc_flows_state_hash_unique").on(table.stateHash),
    index("auth_oidc_flows_expires_at_index").on(table.expiresAt),
    check(
      "auth_oidc_flows_hashes_check",
      sql`${table.flowHash} ~ '^[0-9a-f]{64}$' AND ${table.stateHash} ~ '^[0-9a-f]{64}$' AND ${table.nonceHash} ~ '^[0-9a-f]{64}$' AND (${table.sessionTokenHash} IS NULL OR ${table.sessionTokenHash} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "auth_oidc_flows_mode_owner_check",
      sql`(${table.mode} = 'login' AND ${table.userId} IS NULL AND ${table.sessionTokenHash} IS NULL) OR (${table.mode} = 'link' AND ${table.userId} IS NOT NULL AND ${table.sessionTokenHash} IS NOT NULL)`,
    ),
    check(
      "auth_oidc_flows_expiry_check",
      sql`${table.createdAt} < ${table.expiresAt}`,
    ),
    check(
      "auth_oidc_flows_consumed_at_check",
      sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    scope: authRateLimitScope().notNull(),
    subjectKind: authRateLimitSubjectKind("subject_kind").notNull(),
    subjectHash: text("subject_hash").notNull(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "auth_rate_limits_primary_key",
      columns: [table.scope, table.subjectKind, table.subjectHash],
    }),
    index("auth_rate_limits_expires_at_index").on(table.expiresAt),
    check(
      "auth_rate_limits_subject_hash_check",
      sql`${table.subjectHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "auth_rate_limits_window_check",
      sql`${table.windowStartedAt} < ${table.expiresAt}`,
    ),
    check(
      "auth_rate_limits_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);

export const authPasswordLoginLimits = pgTable(
  "auth_password_login_limits",
  {
    subjectKind: text("subject_kind").notNull(),
    subjectHash: text("subject_hash").notNull(),
    windowId: uuid("window_id").notNull().defaultRandom(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    pendingAttempts: uuid("pending_attempts")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
  },
  (table) => [
    primaryKey({ columns: [table.subjectKind, table.subjectHash] }),
    index("auth_password_login_limits_expires_at_index").on(table.expiresAt),
    check(
      "auth_password_login_limits_subject_check",
      sql`${table.subjectKind} IN ('client_address', 'identifier_client_address') AND ${table.subjectHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "auth_password_login_limits_window_check",
      sql`${table.windowStartedAt} < ${table.expiresAt}`,
    ),
    check(
      "auth_password_login_limits_budget_check",
      sql`
      ${table.attemptCount} >= 0
      AND coalesce(array_ndims(${table.pendingAttempts}), 1) = 1
      AND coalesce(array_lower(${table.pendingAttempts}, 1), 1) = 1
      AND array_position(${table.pendingAttempts}, NULL) IS NULL
      AND ((${table.subjectKind} = 'client_address' AND ${table.attemptCount} <= 100 AND cardinality(${table.pendingAttempts}) = 0)
        OR (${table.subjectKind} = 'identifier_client_address' AND ${table.attemptCount} + cardinality(${table.pendingAttempts}) <= 10))
    `,
    ),
  ],
);
