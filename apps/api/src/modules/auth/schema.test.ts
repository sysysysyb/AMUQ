import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  authIdentities,
  authLinkSessions,
  authOidcFlows,
  authPasswordLoginLimits,
  authRateLimits,
  authRateLimitScope,
  authSessions,
  authTokens,
  users,
} from "#api/modules/auth/schema";
import { emailOutbox } from "#api/modules/email/schema";

describe("authentication schema", () => {
  it("bounds password login counters and pending reservations in the database", () => {
    expect(getTableName(authPasswordLoginLimits)).toBe(
      "auth_password_login_limits",
    );
    expect(columnNames(authPasswordLoginLimits)).toEqual([
      "subject_kind",
      "subject_hash",
      "window_id",
      "window_started_at",
      "expires_at",
      "attempt_count",
      "pending_attempts",
    ]);
    expect(checkNames(authPasswordLoginLimits)).toEqual(
      expect.arrayContaining([
        "auth_password_login_limits_subject_check",
        "auth_password_login_limits_window_check",
        "auth_password_login_limits_budget_check",
      ]),
    );
  });
  it("defines only hashed authentication and rate-limit credentials", () => {
    expect(authRateLimitScope.enumValues).toContain("login");
    expect(authRateLimitScope.enumValues).toContain("password_reset_resend");
    expect(
      [
        users,
        authIdentities,
        authSessions,
        authTokens,
        authOidcFlows,
        authLinkSessions,
        emailOutbox,
        authRateLimits,
      ].map(getTableName),
    ).toEqual([
      "users",
      "auth_identities",
      "auth_sessions",
      "auth_tokens",
      "auth_oidc_flows",
      "auth_link_sessions",
      "email_outbox",
      "auth_rate_limits",
    ]);

    expect(columnNames(authSessions)).toContain("token_hash");
    expect(columnNames(authTokens)).toContain("token_hash");
    expect(columnNames(authOidcFlows)).toEqual(
      expect.arrayContaining(["flow_hash", "state_hash", "nonce_hash"]),
    );
    expect(columnNames(authOidcFlows)).not.toEqual(
      expect.arrayContaining(["flow_token", "state", "nonce", "code_verifier"]),
    );
    expect(columnNames(authLinkSessions)).toContain("token_hash");
    expect(columnNames(authLinkSessions)).not.toContain("token");
    expect(columnNames(authRateLimits)).toContain("subject_hash");
    expect(columnNames(authRateLimits)).not.toEqual(
      expect.arrayContaining(["email", "ip_address", "raw_identifier"]),
    );
    expect(columnNames(emailOutbox)).not.toEqual(
      expect.arrayContaining(["body", "raw_token", "token"]),
    );
    expect(
      columnNames(emailOutbox).filter((name) =>
        ["user_id", "kind", "recipient"].includes(name),
      ),
    ).toEqual([]);
    expect(columnNames(emailOutbox)).toContain("token_id");
  });

  it("keeps identity ownership and lifecycle bounds in the database", () => {
    expect(getTableConfig(authIdentities).columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "provider_subject", notNull: false }),
      ]),
    );
    expect(checkNames(authIdentities)).toEqual(
      expect.arrayContaining([
        "auth_identities_provider_subject_check",
        "auth_identities_password_hash_check",
      ]),
    );
    expect(checkNames(authSessions)).toEqual(
      expect.arrayContaining([
        "auth_sessions_token_hash_check",
        "auth_sessions_expiry_check",
        "auth_sessions_revoked_at_check",
      ]),
    );
    expect(checkNames(authTokens)).toEqual(
      expect.arrayContaining([
        "auth_tokens_token_hash_check",
        "auth_tokens_expiry_check",
        "auth_tokens_consumed_at_check",
      ]),
    );
    expect(checkNames(authOidcFlows)).toEqual(
      expect.arrayContaining([
        "auth_oidc_flows_hashes_check",
        "auth_oidc_flows_mode_owner_check",
        "auth_oidc_flows_expiry_check",
        "auth_oidc_flows_consumed_at_check",
      ]),
    );
    expect(columnNames(authIdentities)).toEqual(
      expect.arrayContaining(["verified_at", "activated_at"]),
    );
    expect(checkNames(authLinkSessions)).toEqual(
      expect.arrayContaining([
        "auth_link_sessions_token_hash_check",
        "auth_link_sessions_provider_check",
        "auth_link_sessions_expiry_check",
        "auth_link_sessions_consumed_at_check",
      ]),
    );
    expect(checkNames(authRateLimits)).toEqual(
      expect.arrayContaining([
        "auth_rate_limits_subject_hash_check",
        "auth_rate_limits_window_check",
        "auth_rate_limits_attempt_count_check",
      ]),
    );
  });
});

const columnNames = (table: Parameters<typeof getTableConfig>[0]) => {
  return getTableConfig(table).columns.map(({ name }) => name);
};

const checkNames = (table: Parameters<typeof getTableConfig>[0]) => {
  return getTableConfig(table).checks.map(({ name }) => name);
};
