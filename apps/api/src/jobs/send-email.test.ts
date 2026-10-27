import { describe, expect, it, vi } from "vitest";

import {
  deliverPendingEmails,
  emailDeliveryConfig,
} from "#api/jobs/send-email";
import { authTokenKeyId, deriveAuthToken } from "#api/modules/auth/token";
import {
  type ResendEmail,
  ResendEmailError,
  type ResendEmailResult,
} from "#api/modules/email/resend";

const authTokenSecret = "a".repeat(32);
const now = new Date("2026-09-27T00:10:00.000Z");
const pendingEmail = {
  claimedAt: now,
  createdAt: new Date("2026-09-27T00:00:00.000Z"),
  expiresAt: new Date("2026-09-28T00:00:00.000Z"),
  outboxId: "7a7fbf25-a614-4fa0-968a-d5b9f209da25",
  payloadHash: null,
  purpose: "email_verification" as const,
  email: "learner@example.com",
  tokenId: "9a268713-29db-4bfd-94c9-e74329cc17a9",
  tokenKeyId: authTokenKeyId(authTokenSecret),
  webOrigin: "https://example.com",
};

const fakeDatabase = (rows: (typeof pendingEmail)[]) => {
  const remaining = [...rows];
  return {
    executeSql: vi.fn(async (sql: string) => ({
      rows: sql.includes("SELECT * FROM claimed")
        ? remaining.splice(0, 1)
        : sql.includes("RETURNING id")
          ? [{ id: pendingEmail.outboxId }]
          : [],
    })),
  };
};

describe("email outbox delivery", () => {
  it("does not claim pending email for a consumed token", async () => {
    const database = fakeDatabase([]);

    await deliverPendingEmails(database, {
      authTokenSecret,
      clock: () => now,
      from: "AMUQ <account@example.com>",
      sendEmail: vi.fn(),
      webOrigin: "https://example.com",
    });

    const claim = database.executeSql.mock.calls.find(([sql]) =>
      sql.includes("SELECT * FROM claimed"),
    );
    expect(claim?.[0]).toContain("token.consumed_at IS NULL");
  });

  it("retires a pending outbox row after its token was consumed", async () => {
    const database = {
      executeSql: vi.fn(async (sql: string) => ({
        rows: sql.includes("consumed_at IS NOT NULL")
          ? [{ id: pendingEmail.outboxId }]
          : [],
      })),
    };
    const sendEmail = vi.fn();

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => now,
        from: "AMUQ <account@example.com>",
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 1, retrying: 0, sent: 0 });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("recreates the one-time link, sends once, and stores no raw token", async () => {
    const database = fakeDatabase([pendingEmail]);
    const sendEmail = vi.fn<(email: ResendEmail) => Promise<ResendEmailResult>>(
      async () => ({
        providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
      }),
    );

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        from: "AMUQ <account@example.com>",
        clock: () => now,
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 0, retrying: 0, sent: 1 });

    const rawToken = deriveAuthToken(
      pendingEmail.purpose,
      pendingEmail.tokenId,
      authTokenSecret,
    );
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `auth-email/${pendingEmail.outboxId}`,
        to: pendingEmail.email,
      }),
    );
    expect(sendEmail.mock.calls[0]?.[0].text).toContain(
      `https://example.com/verify-email?token=${rawToken}`,
    );
    expect(JSON.stringify(database.executeSql.mock.calls)).not.toContain(
      rawToken,
    );
  });

  it("keeps a safe retryable failure pending without storing provider content", async () => {
    const database = fakeDatabase([pendingEmail]);
    const sendEmail = vi.fn(async () => {
      throw new ResendEmailError("resend_network", true);
    });

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        from: "AMUQ <account@example.com>",
        clock: () => now,
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 0, retrying: 1, sent: 0 });

    expect(database.executeSql).toHaveBeenCalledWith(
      expect.stringContaining("WHEN $4 THEN 'pending'"),
      [pendingEmail.outboxId, "resend_network", now, true, now],
    );
  });

  it("retries when this worker does not know a newer token key", async () => {
    const database = fakeDatabase([
      {
        ...pendingEmail,
        tokenKeyId: authTokenKeyId("b".repeat(32)),
      },
    ]);
    const sendEmail = vi.fn();

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => now,
        from: "AMUQ <account@example.com>",
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 0, retrying: 1, sent: 0 });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(database.executeSql).toHaveBeenCalledWith(
      expect.stringContaining("WHEN $4 THEN 'pending'"),
      [pendingEmail.outboxId, "auth_token_key_unavailable", now, true, now],
    );
  });

  it("stops retrying an expired email with an unknown token key", async () => {
    const database = fakeDatabase([
      {
        ...pendingEmail,
        expiresAt: now,
        tokenKeyId: authTokenKeyId("b".repeat(32)),
      },
    ]);
    const sendEmail = vi.fn();

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => now,
        from: "AMUQ <account@example.com>",
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 1, retrying: 0, sent: 0 });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(database.executeSql).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      [pendingEmail.outboxId, "token_expired", now, now],
    );
  });

  it("stops automatic delivery after Resend's 24-hour idempotency window", async () => {
    const database = fakeDatabase([
      {
        ...pendingEmail,
        createdAt: new Date("2026-09-26T00:10:00.000Z"),
        expiresAt: new Date("2026-09-28T00:00:00.000Z"),
      },
    ]);
    const sendEmail = vi.fn();

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        from: "AMUQ <account@example.com>",
        clock: () => now,
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 1, retrying: 0, sent: 0 });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(database.executeSql).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      [pendingEmail.outboxId, "idempotency_expired", now, now],
    );
    const terminalUpdate = database.executeSql.mock.calls.find(([sql]) =>
      sql.includes("UPDATE email_outbox"),
    );
    expect(terminalUpdate?.[0]).not.toContain(
      "attempt_count = attempt_count + 1",
    );
  });

  it("rechecks the deadline before each provider request", async () => {
    const expiringAt = new Date("2026-09-27T00:10:15.000Z");
    const database = fakeDatabase([
      pendingEmail,
      {
        ...pendingEmail,
        expiresAt: new Date("2026-09-27T00:10:20.000Z"),
        outboxId: "8b80c1ea-27bb-48cc-8245-1e88339e981e",
      },
    ]);
    const times = [
      new Date("2026-09-27T00:10:00.000Z"),
      new Date("2026-09-27T00:10:00.000Z"),
      new Date("2026-09-27T00:10:00.000Z"),
      new Date("2026-09-27T00:10:00.000Z"),
      expiringAt,
      expiringAt,
      expiringAt,
      expiringAt,
      expiringAt,
    ];
    const sendEmail = vi.fn(async () => ({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    }));

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => times.shift()!,
        from: "AMUQ <account@example.com>",
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 1, retrying: 0, sent: 1 });

    expect(sendEmail).toHaveBeenCalledOnce();
    expect(database.executeSql).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      [
        "8b80c1ea-27bb-48cc-8245-1e88339e981e",
        "token_expired",
        expiringAt,
        expiringAt,
      ],
    );
  });

  it("rechecks the deadline after preparing the provider payload", async () => {
    const expiringAt = new Date("2026-09-27T00:10:15.000Z");
    const preparedAt = new Date("2026-09-27T00:10:06.000Z");
    let currentTime = new Date("2026-09-27T00:10:00.000Z");
    const baseDatabase = fakeDatabase([
      { ...pendingEmail, expiresAt: expiringAt },
    ]);
    const database = {
      executeSql: vi.fn(async (sql: string) => {
        const result = await baseDatabase.executeSql(sql);
        if (sql.includes("SET payload_hash")) currentTime = preparedAt;
        return result;
      }),
    };
    const sendEmail = vi.fn();

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => currentTime,
        from: "AMUQ <account@example.com>",
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 1, retrying: 0, sent: 0 });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(database.executeSql).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      [pendingEmail.outboxId, "token_expired", preparedAt, preparedAt],
    );
  });

  it("does not send when the token is consumed after the row is claimed", async () => {
    const baseDatabase = fakeDatabase([pendingEmail]);
    const database = {
      executeSql: vi.fn(async (sql: string) =>
        sql.includes("AND EXISTS (")
          ? { rows: [] }
          : baseDatabase.executeSql(sql),
      ),
    };
    const sendEmail = vi.fn();

    await expect(
      deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => now,
        from: "AMUQ <account@example.com>",
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).resolves.toEqual({ failed: 0, retrying: 0, sent: 0 });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("requires complete delivery secrets and a secure production origin", () => {
    expect(() =>
      emailDeliveryConfig({
        AMUQ_ENV: "production",
        AUTH_TOKEN_SECRET: "short",
        RESEND_API_KEY: "re_test",
        RESEND_FROM_EMAIL: "AMUQ <account@example.com>",
        WEB_ORIGIN: "http://example.com",
      }),
    ).toThrow("AUTH_TOKEN_SECRET must be at least 32 bytes");

    expect(() =>
      emailDeliveryConfig({
        AMUQ_ENV: "production",
        AUTH_TOKEN_PREVIOUS_SECRET: "b".repeat(32),
        AUTH_TOKEN_SECRET: authTokenSecret,
        RESEND_API_KEY: "re_test",
        RESEND_FROM_EMAIL: "AMUQ <account@example.com>",
        WEB_ORIGIN: "http://example.com",
      }),
    ).toThrow("WEB_ORIGIN must use HTTPS in production");

    expect(
      emailDeliveryConfig({
        AMUQ_ENV: "production",
        AUTH_TOKEN_PREVIOUS_SECRET: "b".repeat(32),
        AUTH_TOKEN_SECRET: authTokenSecret,
        RESEND_API_KEY: "re_test",
        RESEND_FROM_EMAIL: "AMUQ <account@example.com>",
        WEB_ORIGIN: "https://example.com",
      }).authTokenPreviousSecret,
    ).toBe("b".repeat(32));
  });
});
