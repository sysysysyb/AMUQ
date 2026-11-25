import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import { deliverPendingEmails } from "#backend/jobs/send-email";
import {
  consumeAuthToken,
  issueAuthToken,
} from "#backend/modules/auth/service";
import { authTokenSecret } from "#backend-test/support/auth-test-secrets";
import { createTestDatabase } from "#backend-test/support/database-fixture";

const { admin, connectionString, databaseTest } = createTestDatabase("suite");

databaseTest("database deployment", () => {
  it("claims a pending outbox row once across concurrent workers", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('concurrent-delivery@example.com') RETURNING id::text",
    );
    await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const deliveryPool = new Pool({ connectionString, max: 2 });
    const database = {
      executeSql: async (text: string, values?: unknown[]) =>
        deliveryPool.query(text, values),
    };
    let acceptDelivery!: () => void;
    const deliveryAccepted = new Promise<void>((resolve) => {
      acceptDelivery = resolve;
    });
    const sendEmail = vi.fn(async () => {
      await deliveryAccepted;
      return {
        providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
      };
    });
    const options = {
      authTokenSecret,
      clock: () => new Date("2026-09-27T00:01:00.000Z"),
      from: "AMUQ <account@example.com>",
      sendEmail,
      webOrigin: "https://example.com",
    };

    const firstDelivery = deliverPendingEmails(database, options);
    try {
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
      const secondDelivery = await deliverPendingEmails(database, options);
      acceptDelivery();
      const firstResult = await firstDelivery;

      expect(sendEmail).toHaveBeenCalledOnce();
      expect(firstResult).toEqual({ failed: 0, retrying: 0, sent: 1 });
      expect(secondDelivery).toEqual({ failed: 0, retrying: 0, sent: 0 });
      const stored = await admin!.query<{
        attemptCount: number;
        status: string;
      }>('SELECT attempt_count AS "attemptCount", status FROM email_outbox');
      expect(stored.rows).toEqual([{ attemptCount: 1, status: "sent" }]);
    } finally {
      acceptDelivery();
      await firstDelivery.catch(() => undefined);
      await deliveryPool.end();
    }
  });

  it("does not retire an active delivery claim when its token is consumed", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('consumed-during-delivery@example.com') RETURNING id::text",
    );
    const token = await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const deliveryPool = new Pool({ connectionString, max: 2 });
    const database = {
      executeSql: async (text: string, values?: unknown[]) =>
        deliveryPool.query(text, values),
    };
    let acceptDelivery!: () => void;
    const deliveryAccepted = new Promise<void>((resolve) => {
      acceptDelivery = resolve;
    });
    const sendEmail = vi.fn(async () => {
      await deliveryAccepted;
      return {
        providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
      };
    });
    const claimedAt = new Date("2026-09-27T00:01:00.000Z");
    const firstDelivery = deliverPendingEmails(database, {
      authTokenSecret,
      clock: () => claimedAt,
      from: "AMUQ <account@example.com>",
      sendEmail,
      webOrigin: "https://example.com",
    });

    try {
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
      await consumeAuthToken(
        admin!,
        "email_verification",
        token.rawToken,
        new Date(claimedAt.getTime() + 1_000),
      );
      const cleanupResult = await deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => new Date(claimedAt.getTime() + 2_000),
        from: "AMUQ <account@example.com>",
        sendEmail: vi.fn(),
        webOrigin: "https://example.com",
      });
      acceptDelivery();
      const deliveryResult = await firstDelivery;

      expect(cleanupResult).toEqual({ failed: 0, retrying: 0, sent: 0 });
      expect(deliveryResult).toEqual({ failed: 0, retrying: 0, sent: 1 });
      const stored = await admin!.query<{
        attemptCount: number;
        status: string;
      }>('SELECT attempt_count AS "attemptCount", status FROM email_outbox');
      expect(stored.rows).toEqual([{ attemptCount: 1, status: "sent" }]);
    } finally {
      acceptDelivery();
      await firstDelivery.catch(() => undefined);
      await deliveryPool.end();
    }
  });

  it("does not steal an active delivery claim when its token expires", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('expires-during-delivery@example.com') RETURNING id::text",
    );
    const claimedAt = new Date("2026-09-27T00:01:00.000Z");
    const expiresAt = new Date(claimedAt.getTime() + 20_000);
    const token = await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    await admin!.query("UPDATE auth_tokens SET expires_at = $2 WHERE id = $1", [
      token.id,
      expiresAt,
    ]);
    const deliveryPool = new Pool({ connectionString, max: 2 });
    const database = {
      executeSql: async (text: string, values?: unknown[]) =>
        deliveryPool.query(text, values),
    };
    let acceptDelivery!: () => void;
    const deliveryAccepted = new Promise<void>((resolve) => {
      acceptDelivery = resolve;
    });
    const sendEmail = vi.fn(async () => {
      await deliveryAccepted;
      return {
        providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
      };
    });
    const firstDelivery = deliverPendingEmails(database, {
      authTokenSecret,
      clock: () => claimedAt,
      from: "AMUQ <account@example.com>",
      sendEmail,
      webOrigin: "https://example.com",
    });

    try {
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
      const secondDelivery = await deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => new Date(expiresAt.getTime() + 1_000),
        from: "AMUQ <account@example.com>",
        sendEmail: vi.fn(),
        webOrigin: "https://example.com",
      });
      acceptDelivery();
      const firstResult = await firstDelivery;

      expect(secondDelivery).toEqual({ failed: 0, retrying: 0, sent: 0 });
      expect(firstResult).toEqual({ failed: 0, retrying: 0, sent: 1 });
      const stored = await admin!.query<{
        attemptCount: number;
        status: string;
      }>('SELECT attempt_count AS "attemptCount", status FROM email_outbox');
      expect(stored.rows).toEqual([{ attemptCount: 1, status: "sent" }]);
    } finally {
      acceptDelivery();
      await firstDelivery.catch(() => undefined);
      await deliveryPool.end();
    }
  });

  it("prevents an expired worker claim from overwriting a newer delivery", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('stale-claim@example.com') RETURNING id::text",
    );
    await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date("2026-09-27T00:00:00.000Z"),
    );
    const deliveryPool = new Pool({ connectionString, max: 2 });
    let releaseStaleClaim!: () => void;
    let reportStaleClaim!: () => void;
    const staleClaimReleased = new Promise<void>((resolve) => {
      releaseStaleClaim = resolve;
    });
    const staleClaimReported = new Promise<void>((resolve) => {
      reportStaleClaim = resolve;
    });
    const staleDatabase = {
      executeSql: async (text: string, values?: unknown[]) => {
        const result = await deliveryPool.query(text, values);
        if (text.includes("SELECT * FROM claimed") && result.rows[0]) {
          reportStaleClaim();
          await staleClaimReleased;
        }
        return result;
      },
    };
    const activeDatabase = {
      executeSql: async (text: string, values?: unknown[]) =>
        deliveryPool.query(text, values),
    };
    const staleSendEmail = vi.fn();
    const activeSendEmail = vi.fn(async () => ({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    }));
    const sharedOptions = {
      authTokenSecret,
      from: "AMUQ <account@example.com>",
      webOrigin: "https://example.com",
    };
    const staleDelivery = deliverPendingEmails(staleDatabase, {
      ...sharedOptions,
      clock: () => new Date("2026-09-27T00:01:00.000Z"),
      sendEmail: staleSendEmail,
    });

    try {
      await staleClaimReported;
      const activeResult = await deliverPendingEmails(activeDatabase, {
        ...sharedOptions,
        clock: () => new Date("2026-09-27T00:02:01.000Z"),
        sendEmail: activeSendEmail,
      });
      releaseStaleClaim();
      const staleResult = await staleDelivery;

      expect(activeResult).toEqual({ failed: 0, retrying: 0, sent: 1 });
      expect(staleResult).toEqual({ failed: 0, retrying: 0, sent: 0 });
      expect(activeSendEmail).toHaveBeenCalledOnce();
      expect(staleSendEmail).not.toHaveBeenCalled();
      const stored = await admin!.query<{
        attemptCount: number;
        status: string;
      }>('SELECT attempt_count AS "attemptCount", status FROM email_outbox');
      expect(stored.rows).toEqual([{ attemptCount: 2, status: "sent" }]);
    } finally {
      releaseStaleClaim();
      await staleDelivery.catch(() => undefined);
      await deliveryPool.end();
    }
  });
});
