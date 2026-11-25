import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import {
  issueSignupChallenge,
  resendSignupChallenge,
  verifySignupChallenge,
} from "#backend/modules/auth/signup-challenge";
import { deriveSignupCode } from "#backend/modules/auth/signup-token";
import { authTokenSecret } from "#backend-test/support/auth-database";
import { setupSignupChallenge } from "#backend-test/support/auth-signup-challenge";

const {
  admin,
  connectionString,
  options,
  at,
  email,
  start,
  codeFor,
  databaseTest,
} = setupSignupChallenge();

databaseTest("signup ownership challenge", () => {
  it("issues and verifies without creating a user or persisting the raw credentials", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const code = await codeFor(challenge.attemptToken);
    const verified = await verifySignupChallenge(
      admin!,
      challenge.attemptToken,
      code,
      options,
      at(599),
    );
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified")
      throw new Error("Expected verified proof");
    expect(verified.proofExpiresAt).toEqual(at(599 + 1_800)());
    const stored = await admin!
      .query(`SELECT row_to_json(attempt) AS attempt, row_to_json(code) AS code
      FROM auth_signup_attempts attempt JOIN auth_signup_codes code ON code.attempt_id = attempt.id`);
    const serialized = JSON.stringify(stored.rows);
    expect(serialized).not.toContain(challenge.attemptToken);
    expect(serialized).not.toContain(verified.signupProof);
    expect(stored.rows[0].code.code_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(stored.rows[0].code)).not.toContain(code);
    expect((await admin!.query("SELECT * FROM users")).rows).toEqual([]);
    expect((await admin!.query("SELECT * FROM auth_identities")).rows).toEqual(
      [],
    );
  });

  it("expires the code exactly at ten minutes and never extends a replayed proof", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const code = await codeFor(challenge.attemptToken);
    expect(
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        code,
        options,
        at(600),
      ),
    ).toMatchObject({ status: "expired" });
    const fresh = await start(601);
    const freshCode = await codeFor(fresh.attemptToken);
    const proof = await verifySignupChallenge(
      admin!,
      fresh.attemptToken,
      freshCode,
      options,
      at(602),
    );
    expect(
      await verifySignupChallenge(
        admin!,
        fresh.attemptToken,
        freshCode,
        options,
        at(2_401),
      ),
    ).toEqual(proof);
    expect(
      await verifySignupChallenge(
        admin!,
        fresh.attemptToken,
        freshCode,
        options,
        at(2_402),
      ),
    ).toMatchObject({ status: "expired" });
  });

  it("commits exactly five wrong guesses even under concurrent verification", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const correct = await codeFor(challenge.attemptToken);
    const wrong = correct === "000000" ? "000001" : "000000";
    const pool = new Pool({ connectionString, max: 6 });
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          verifySignupChallenge(
            pool,
            challenge.attemptToken,
            wrong,
            options,
            at(1),
          ),
        ),
      );
      expect(
        results.filter((result) => result.status === "invalid_code"),
      ).toHaveLength(4);
      expect(
        results.filter((result) => result.status === "attempts_exhausted"),
      ).toHaveLength(2);
      expect(
        (await admin!.query("SELECT wrong_attempts FROM auth_signup_codes"))
          .rows,
      ).toEqual([{ wrong_attempts: 5 }]);
      expect(
        await verifySignupChallenge(
          admin!,
          challenge.attemptToken,
          correct,
          options,
          at(2),
        ),
      ).toMatchObject({ status: "attempts_exhausted" });
    } finally {
      await pool.end();
    }
  });

  it("resends revoke old codes while preserving another attempt's valid proof", async () => {
    await migrateDatabase(connectionString!);
    const first = await start();
    const code = await codeFor(first.attemptToken);
    const proof = await verifySignupChallenge(
      admin!,
      first.attemptToken,
      code,
      options,
      at(1),
    );
    const next = await start(60, "203.0.113.2");
    expect(
      await verifySignupChallenge(
        admin!,
        first.attemptToken,
        code,
        options,
        at(61),
      ),
    ).toEqual(proof);
    const oldCode = await codeFor(next.attemptToken);
    await resendSignupChallenge(
      admin!,
      next.attemptToken,
      randomUUID(),
      "203.0.113.2",
      options,
      at(120),
    );
    expect(
      await verifySignupChallenge(
        admin!,
        next.attemptToken,
        oldCode,
        options,
        at(121),
      ),
    ).toMatchObject({ status: "invalid_code" });
  });

  it("blocks guessing a verified code after five failed replay attempts without revoking the proof", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const correct = await codeFor(challenge.attemptToken);
    const proof = await verifySignupChallenge(
      admin!,
      challenge.attemptToken,
      correct,
      options,
      at(1),
    );
    const wrong = correct === "000000" ? "000001" : "000000";
    for (let count = 0; count < 5; count += 1)
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        wrong,
        options,
        at(2),
      );
    expect(
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        correct,
        options,
        at(3),
      ),
    ).toMatchObject({ status: "attempts_exhausted" });
    expect(proof.status).toBe("verified");
    expect(
      (
        await admin!.query(
          "SELECT proof_hash, proof_consumed_at FROM auth_signup_attempts",
        )
      ).rows[0],
    ).toMatchObject({
      proof_consumed_at: null,
      proof_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("recovers an issued challenge and verified proof across signing-key rotation", async () => {
    await migrateDatabase(connectionString!);
    const operation = randomUUID();
    const first = await start(0, "203.0.113.1", operation);
    const code = await codeFor(first.attemptToken);
    const proof = await verifySignupChallenge(
      admin!,
      first.attemptToken,
      code,
      options,
      at(1),
    );
    const rotated = {
      ...options,
      authTokenSecret: "b".repeat(32),
      authTokenPreviousSecret: authTokenSecret,
    };
    expect(
      await issueSignupChallenge(
        admin!,
        email,
        operation,
        "203.0.113.1",
        rotated,
        at(2),
      ),
    ).toEqual(first);
    expect(
      await verifySignupChallenge(
        admin!,
        first.attemptToken,
        code,
        rotated,
        at(2),
      ),
    ).toEqual(proof);
  });

  it("enforces code attempts, exact lifetimes, and one outbox source in PostgreSQL", async () => {
    await migrateDatabase(connectionString!);
    await start();
    await expect(
      admin!.query("UPDATE auth_signup_codes SET wrong_attempts = 6"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin!.query(
        "UPDATE auth_signup_codes SET expires_at = expires_at + interval '1 second'",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin!.query("UPDATE email_outbox SET signup_code_id = NULL"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("returns expired verification and permits reissuance when the old signing key is unavailable", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const code = await codeFor(challenge.attemptToken);
    const rotated = { ...options, authTokenSecret: "b".repeat(32) };
    expect(
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        code,
        rotated,
        at(1),
      ),
    ).toMatchObject({ status: "expired" });
    const reissued = await resendSignupChallenge(
      admin!,
      challenge.attemptToken,
      randomUUID(),
      "203.0.113.1",
      rotated,
      at(60),
    );
    expect(reissued.attemptToken).toBe(challenge.attemptToken);
    const latest = (
      await admin!.query(
        "SELECT id FROM auth_signup_codes ORDER BY created_at DESC LIMIT 1",
      )
    ).rows[0];
    expect(
      await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        deriveSignupCode(latest.id, rotated.authTokenSecret),
        rotated,
        at(61),
      ),
    ).toMatchObject({ status: "verified" });
  });

  it.each(["verify_first", "resend_first"] as const)(
    "serializes %s without replacing a granted proof",
    async (ordering) => {
      await migrateDatabase(connectionString!);
      const challenge = await start();
      const oldCode = await codeFor(challenge.attemptToken);
      const pool = new Pool({
        connectionString,
        max: 3,
        application_name: "signup-verify-resend-race",
      });
      const blocker = await pool.connect();
      let requests: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`amuq:signup-email:${email}`],
        );
        const waitForQueued = async (count: number) =>
          vi.waitFor(async () => {
            const waiting = await admin!.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'signup-verify-resend-race' AND wait_event_type = 'Lock'",
            );
            expect(waiting.rows[0].count).toBe(count);
          });
        const verify = () =>
          verifySignupChallenge(
            pool,
            challenge.attemptToken,
            oldCode,
            options,
            at(60),
          );
        const reissue = () =>
          resendSignupChallenge(
            pool,
            challenge.attemptToken,
            randomUUID(),
            "203.0.113.1",
            options,
            at(60),
          );
        const first = ordering === "verify_first" ? verify() : reissue();
        // Register rejection handlers before releasing either queued request.
        const firstSettled = Promise.allSettled([first]);
        await waitForQueued(1);
        const second = ordering === "verify_first" ? reissue() : verify();
        requests = Promise.allSettled([first, second]);
        await waitForQueued(2);
        await blocker.query("COMMIT");
        const settled = await requests;
        await firstSettled;
        const [verified, resent] =
          ordering === "verify_first" ? settled : [settled[1], settled[0]];
        expect(verified!.status).toBe("fulfilled");
        if (verified!.status !== "fulfilled")
          throw new Error("Verification rejected");
        const firstProof = verified!.value as Awaited<
          ReturnType<typeof verifySignupChallenge>
        >;
        const final = await verifySignupChallenge(
          admin!,
          challenge.attemptToken,
          await codeFor(challenge.attemptToken),
          options,
          at(61),
        );
        expect(final.status).toBe("verified");
        if (firstProof.status === "verified") expect(final).toEqual(firstProof);
        else expect(resent!.status).toBe("fulfilled");
        expect(
          (
            await admin!.query(
              "SELECT count(*)::int AS count FROM auth_signup_codes",
            )
          ).rows[0].count,
        ).toBe(ordering === "verify_first" ? 1 : 2);
      } finally {
        await blocker.query("ROLLBACK");
        await requests;
        blocker.release();
        await pool.end();
      }
    },
  );
});
