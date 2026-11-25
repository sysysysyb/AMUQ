import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import {
  cleanupSignupChallenges,
  resendSignupChallenge,
  verifySignupChallenge,
} from "#backend/modules/auth/signup-challenge";
import { hashOpaqueToken } from "#backend/modules/auth/token";
import { setupSignupChallenge } from "#backend-test/support/auth-signup-challenge";

const {
  admin,
  connectionString,
  now,
  options,
  at,
  email,
  start,
  codeFor,
  deliver,
  databaseTest,
} = setupSignupChallenge();

databaseTest("signup ownership challenge", () => {
  it("cleans expired attempts only after mail claims, proof, and shared issuance budgets end", async () => {
    await migrateDatabase(connectionString!);
    const first = await start();
    const second = await start(60);
    const code = await codeFor(second.attemptToken);
    await verifySignupChallenge(
      admin!,
      second.attemptToken,
      code,
      options,
      at(61),
    );
    const database = {
      executeSql: (sql: string, values?: unknown[]) =>
        admin!.query(sql, values),
    };
    expect(await cleanupSignupChallenges(database, at(3_659)())).toBe(0);
    // A pending/claimed row is retained even after its credential has expired.
    expect(await cleanupSignupChallenges(database, at(3_660)())).toBe(1);
    expect(
      (await admin!.query("SELECT token_hash FROM auth_signup_attempts")).rows,
    ).toEqual([{ token_hash: hashOpaqueToken(second.attemptToken) }]);
    await deliver(vi.fn(), 3_661);
    expect(await cleanupSignupChallenges(database, at(3_662)())).toBe(1);
    expect(
      (await admin!.query("SELECT * FROM auth_signup_codes")).rows,
    ).toEqual([]);
    expect(first.attemptToken).not.toBe(second.attemptToken);
  });

  it("retains delivered mail and webhook history after temporary credentials expire", async () => {
    await migrateDatabase(connectionString!);
    await start();
    await deliver(async () => ({ providerMessageId: "retained-signup-mail" }));
    await admin!.query(
      `INSERT INTO email_webhook_events (event_id, outbox_id, event_type, occurred_at)
      SELECT 'retained-signup-event', id, 'email.complained', $1 FROM email_outbox`,
      [at(2)()],
    );
    const database = {
      executeSql: (sql: string, values?: unknown[]) =>
        admin!.query(sql, values),
    };
    expect(await cleanupSignupChallenges(database, at(3_601)())).toBe(1);
    expect(
      (await admin!.query("SELECT * FROM auth_signup_attempts")).rows,
    ).toEqual([]);
    expect(
      (await admin!.query("SELECT * FROM auth_signup_codes")).rows,
    ).toEqual([]);
    const retained = (await admin!.query("SELECT * FROM email_outbox")).rows;
    expect(retained[0]).toMatchObject({
      source_kind: "signup_code",
      signup_code_id: null,
      provider_message_id: "retained-signup-mail",
      payload_hash: null,
      token_key_id: null,
    });
    expect(JSON.stringify(retained)).not.toContain(email);
    expect(
      (await admin!.query("SELECT provider_message_id FROM email_outbox")).rows,
    ).toEqual([{ provider_message_id: "retained-signup-mail" }]);
    expect(
      (await admin!.query("SELECT event_id FROM email_webhook_events")).rows,
    ).toEqual([{ event_id: "retained-signup-event" }]);
    await admin!.query("UPDATE email_outbox SET status = 'complained'");
    await expect(
      admin!.query(
        "UPDATE email_outbox SET status = 'pending', token_key_id = repeat('a', 16)",
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "email_outbox_source_check",
    });
  });

  it("finishes bounded delivery-metadata erasure before deleting credential rows", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const attempt = (
      await admin!.query(
        "SELECT id FROM auth_signup_attempts WHERE token_hash = $1",
        [hashOpaqueToken(challenge.attemptToken)],
      )
    ).rows[0];
    await admin!.query(
      "UPDATE email_outbox SET status = 'sent', provider_message_id = 'history-initial', payload_hash = repeat('b', 64)",
    );
    await admin!.query(
      `WITH codes AS (
      INSERT INTO auth_signup_codes (attempt_id, recipient, operation_hash, operation_kind, code_digest, token_key_id, created_at, expires_at, resend_available_at)
      SELECT $1, $2, md5(i::text) || md5(i::text), 'resend', repeat('c',64), repeat('a',16), $3::timestamptz, $3::timestamptz + interval '10 minutes', $3::timestamptz + interval '1 minute'
      FROM generate_series(1,25) i RETURNING id
    ) INSERT INTO email_outbox (source_kind, signup_code_id, status, provider_message_id, payload_hash, token_key_id, created_at, updated_at)
      SELECT 'signup_code', id, 'sent', 'history-' || id::text, repeat('b',64), repeat('a',16), $3, $3 FROM codes`,
      [attempt.id, email, now],
    );
    const database = {
      executeSql: (sql: string, values?: unknown[]) =>
        admin!.query(sql, values),
    };
    expect(await cleanupSignupChallenges(database, at(3_601)())).toBe(0);
    expect(
      (
        await admin!.query(
          "SELECT count(*)::int AS count FROM email_outbox WHERE payload_hash IS NOT NULL OR token_key_id IS NOT NULL",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(await cleanupSignupChallenges(database, at(3_602)())).toBe(1);
    expect(
      (await admin!.query("SELECT * FROM auth_signup_codes")).rows,
    ).toEqual([]);
    expect(
      (
        await admin!.query(
          "SELECT count(*)::int AS count FROM email_outbox WHERE payload_hash IS NULL AND token_key_id IS NULL AND signup_code_id IS NULL",
        )
      ).rows[0].count,
    ).toBe(26);
  });

  it("rechecks a cleanup candidate changed after its statement snapshot", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    await admin!.query("UPDATE email_outbox SET status = 'failed'");
    const pool = new Pool({
      connectionString,
      max: 3,
      application_name: "signup-cleanup-race",
    });
    const blocker = await pool.connect();
    let cleanup: Promise<number> | undefined;
    await admin!
      .query(`CREATE FUNCTION signup_cleanup_barrier() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
      BEGIN PERFORM pg_advisory_xact_lock(893121); RETURN true; END $$`);
    try {
      await blocker.query("SELECT pg_advisory_lock(893121)");
      const database = {
        executeSql: (sql: string, values?: unknown[]) =>
          pool.query(
            sql.replace(
              "ORDER BY attempt.",
              "AND signup_cleanup_barrier() ORDER BY attempt.",
            ),
            values,
          ),
      };
      cleanup = cleanupSignupChallenges(database, at(3_600)());
      await vi.waitFor(async () => {
        const waiting = await admin!.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'signup-cleanup-race' AND wait_event_type = 'Lock' AND query LIKE 'WITH expired AS%'",
        );
        expect(waiting.rows[0].count).toBe(1);
      });
      await resendSignupChallenge(
        admin!,
        challenge.attemptToken,
        randomUUID(),
        "203.0.113.1",
        options,
        at(3_600),
      );
      await blocker.query("SELECT pg_advisory_unlock(893121)");
      expect(await cleanup).toBe(0);
      expect(
        await verifySignupChallenge(
          admin!,
          challenge.attemptToken,
          await codeFor(challenge.attemptToken),
          options,
          at(3_601),
        ),
      ).toMatchObject({ status: "verified" });
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(893121)");
      await cleanup?.catch(() => undefined);
      blocker.release();
      await pool.end();
      await admin!.query("DROP FUNCTION signup_cleanup_barrier()");
    }
  });
});
