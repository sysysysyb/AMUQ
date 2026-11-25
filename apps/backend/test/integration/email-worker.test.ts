import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import { issueAuthToken } from "#backend/modules/auth/service";
import { startWorker, workerDatabaseOptions } from "#backend/worker";
import { authTokenSecret } from "#backend-test/support/auth-test-secrets";
import { createTestDatabase } from "#backend-test/support/database-fixture";

const { admin, connectionString, databaseTest } = createTestDatabase("suite");

databaseTest("database deployment", () => {
  it("processes queue polling load within the one-connection worker budget", async () => {
    await migrateDatabase(connectionString!);
    const boss = new PgBoss(workerDatabaseOptions(connectionString!));
    const queue = "foundation-load";
    const jobCount = 20;
    let processed = 0;
    try {
      await boss.start();
      await boss.createQueue(queue);
      await boss.work(
        queue,
        {
          batchSize: 5,
          localConcurrency: 1,
          pollingIntervalSeconds: 0.5,
        },
        async (jobs) => {
          processed += jobs.length;
        },
      );
      await Promise.all(
        Array.from({ length: jobCount }, (_, sequence) =>
          boss.send(queue, { sequence }),
        ),
      );

      await vi.waitFor(() => expect(processed).toBe(jobCount), {
        timeout: 15_000,
      });
      expect(processed).toBe(jobCount);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000 });
    }
  }, 30_000);

  it("delivers a pending email through the real worker", async () => {
    await migrateDatabase(connectionString!);
    const user = await admin!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('worker-delivery@example.com') RETURNING id::text",
    );
    await issueAuthToken(
      admin!,
      user.rows[0]!.id,
      "email_verification",
      authTokenSecret,
      new Date(),
    );
    const sendEmail = vi.fn(async () => ({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    }));
    const worker = await startWorker({
      connectionString: connectionString!,
      emailDelivery: {
        config: {
          apiKey: "re_test",
          authTokenSecret,
          from: "AMUQ <account@example.com>",
          webOrigin: "https://example.com",
        },
        sendEmail,
      },
      logInfo: vi.fn(),
    });

    try {
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce(), {
        timeout: 10_000,
      });
      await vi.waitFor(
        async () => {
          const outbox = await admin!.query<{ status: string }>(
            "SELECT status FROM email_outbox",
          );
          expect(outbox.rows).toEqual([{ status: "sent" }]);
        },
        { timeout: 10_000 },
      );
    } finally {
      await worker.shutdown();
    }
  }, 30_000);

  it("wakes mail queued after the worker is idle within eight seconds", async () => {
    await migrateDatabase(connectionString!);
    const boss = new PgBoss(workerDatabaseOptions(connectionString!));
    vi.spyOn(boss, "schedule").mockResolvedValue(undefined);
    const sendEmail = vi.fn(async () => ({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    }));
    const worker = await startWorker({
      boss,
      connectionString: connectionString!,
      emailDelivery: {
        config: {
          apiKey: "re_test",
          authTokenSecret,
          from: "AMUQ <account@example.com>",
          webOrigin: "https://example.com",
        },
        sendEmail,
      },
      logInfo: vi.fn(),
    });
    try {
      await vi.waitFor(
        async () => {
          const completed = await admin!.query(
            "SELECT count(*)::int AS count FROM pgboss.job WHERE name='send-email' AND state='completed'",
          );
          expect(completed.rows[0].count).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );
      const user = await admin!.query<{ id: string }>(
        "INSERT INTO users(email) VALUES('fresh-worker@example.com') RETURNING id",
      );
      const started = performance.now();
      await issueAuthToken(
        admin!,
        user.rows[0]!.id,
        "password_reset",
        authTokenSecret,
        new Date(),
      );
      await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce(), {
        timeout: 8_000,
        interval: 25,
      });
      expect(performance.now() - started).toBeLessThan(8_000);
    } finally {
      await worker.shutdown();
    }
  }, 30_000);

  it("starts the real worker with a one-connection database role", async () => {
    await migrateDatabase(connectionString!);
    const role = "amuq_worker_connection_limit";
    const password = randomUUID();
    const workerUrl = new URL(connectionString!);
    workerUrl.username = role;
    workerUrl.password = password;
    await admin!.query(`DROP ROLE IF EXISTS ${role}`);
    await admin!.query(
      `CREATE ROLE ${role} LOGIN CONNECTION LIMIT 1 PASSWORD '${password}'`,
    );

    try {
      const owner = await admin!.query<{ name: string }>(
        "SELECT quote_ident(current_user) AS name",
      );
      await admin!.query(`GRANT ${owner.rows[0]!.name} TO ${role}`);
      const worker = await startWorker({
        connectionString: workerUrl.href,
        logInfo: vi.fn(),
      });
      await worker.shutdown();
    } finally {
      await admin!.query(`DROP ROLE ${role}`);
    }
  }, 30_000);
});
