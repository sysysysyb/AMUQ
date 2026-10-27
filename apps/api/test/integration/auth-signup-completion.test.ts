import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { migrateDatabase } from "#api/db/migrations";
import { hashPassword } from "#api/modules/auth/password";
import {
  authenticatePassword,
  completeSignup,
  issueAuthToken,
  retireLegacySignupTokens,
} from "#api/modules/auth/service";
import {
  issueSignupChallenge,
  verifySignupChallenge,
} from "#api/modules/auth/signup-challenge";
import { deriveSignupCode } from "#api/modules/auth/signup-token";
import { hashOpaqueToken } from "#api/modules/auth/token";
import {
  authTokenSecret,
  setupAuthDatabase,
} from "#api-test/support/auth-database";

const { admin, connectionString, databaseTest } = setupAuthDatabase();
const epoch = new Date("2026-10-21T00:00:00Z");
const at = (seconds: number) => () =>
  new Date(epoch.getTime() + seconds * 1_000);
const options = { authTokenSecret, rateLimitSecret: "r".repeat(32) };
const password = "OwnerPass1234";

const ownership = async (email = "owner@example.com", seconds = 0) => {
  const challenge = await issueSignupChallenge(
    admin!,
    email,
    randomUUID(),
    "203.0.113.1",
    options,
    at(seconds),
  );
  const result = await admin!.query<{ id: string }>(
    `SELECT code.id FROM auth_signup_codes code
     JOIN auth_signup_attempts attempt ON attempt.id = code.attempt_id
     WHERE attempt.token_hash = $1`,
    [hashOpaqueToken(challenge.attemptToken)],
  );
  const verified = await verifySignupChallenge(
    admin!,
    challenge.attemptToken,
    deriveSignupCode(result.rows[0]!.id, authTokenSecret),
    options,
    at(seconds + 1),
  );
  if (verified.status !== "verified")
    throw new Error("Expected ownership proof");
  return verified.signupProof;
};

const legacy = async () => {
  const result = await admin!.query<{ id: string }>(
    "INSERT INTO users (email, created_at, updated_at) VALUES ('owner@example.com', $1, $1) RETURNING id",
    [epoch],
  );
  const id = result.rows[0]!.id;
  await admin!.query(
    `INSERT INTO auth_identities (user_id, provider, password_hash, activated_at, created_at, updated_at)
     VALUES ($1, 'password', $2, $3, $3, $3)`,
    [id, await hashPassword("Attacker12345"), epoch],
  );
  const token = await issueAuthToken(
    admin!,
    id,
    "email_verification",
    authTokenSecret,
    epoch,
  );
  return { id, token };
};

databaseTest("signup completion ownership", () => {
  it("retires old links on transition while preserving active claims and reset tokens", async () => {
    await migrateDatabase(connectionString!);
    const old = await legacy();
    const claimed = await issueAuthToken(
      admin!,
      old.id,
      "email_verification",
      authTokenSecret,
      epoch,
    );
    const reset = await issueAuthToken(
      admin!,
      old.id,
      "password_reset",
      authTokenSecret,
      epoch,
    );
    await admin!.query(
      "UPDATE email_outbox SET attempt_count = 1 WHERE token_id = $1",
      [claimed.id],
    );
    await retireLegacySignupTokens(admin!, at(2)());
    const tokens = await admin!.query(
      "SELECT id, consumed_at FROM auth_tokens ORDER BY id",
    );
    expect(
      tokens.rows.find((row) => row.id === reset.id).consumed_at,
    ).toBeNull();
    expect(
      tokens.rows
        .filter((row) => row.id !== reset.id)
        .every((row) => row.consumed_at.getTime() === at(2)().getTime()),
    ).toBe(true);
    const mail = await admin!.query(
      "SELECT token_id, status, updated_at FROM email_outbox",
    );
    expect(mail.rows.find((row) => row.token_id === old.token.id).status).toBe(
      "failed",
    );
    expect(mail.rows.find((row) => row.token_id === claimed.id)).toMatchObject({
      status: "pending",
      updated_at: epoch,
    });
    expect(mail.rows.find((row) => row.token_id === reset.id).status).toBe(
      "pending",
    );
  });

  it("rejects missing ownership without creating account state", async () => {
    await migrateDatabase(connectionString!);
    expect(
      await completeSignup(admin!, "invalid-proof", password, at(2)),
    ).toEqual({ status: "invalid_proof" });
    expect((await admin!.query("SELECT * FROM users")).rows).toEqual([]);
  });

  it("creates one verified password and never reapplies a replayed password", async () => {
    await migrateDatabase(connectionString!);
    const proof = await ownership();
    expect(await completeSignup(admin!, proof, password, at(2))).toEqual({
      status: "created",
    });
    expect(
      await completeSignup(admin!, proof, "ChangedPass123", at(3)),
    ).toEqual({ status: "already_completed" });
    expect(
      await authenticatePassword(
        admin!,
        "owner@example.com",
        password,
        at(4)(),
      ),
    ).toMatchObject({ status: "authenticated" });
    expect(
      await authenticatePassword(
        admin!,
        "owner@example.com",
        "ChangedPass123",
        at(4)(),
      ),
    ).toBeUndefined();
    expect((await admin!.query("SELECT * FROM auth_tokens")).rows).toEqual([]);
  });

  it("recovers only legacy unverified password accounts and retires old credentials", async () => {
    await migrateDatabase(connectionString!);
    const old = await legacy();
    const proof = await ownership();
    expect(await completeSignup(admin!, proof, password, at(2))).toEqual({
      status: "created",
    });
    const user = await admin!.query("SELECT id, email_verified_at FROM users");
    expect(user.rows).toEqual([{ id: old.id, email_verified_at: at(2)() }]);
    expect(
      await authenticatePassword(
        admin!,
        "owner@example.com",
        "Attacker12345",
        at(3)(),
      ),
    ).toBeUndefined();
    expect(
      await authenticatePassword(
        admin!,
        "owner@example.com",
        password,
        at(3)(),
      ),
    ).toMatchObject({ status: "authenticated" });
    const token = await admin!.query(
      "SELECT consumed_at FROM auth_tokens WHERE id=$1",
      [old.token.id],
    );
    expect(token.rows[0].consumed_at).toEqual(at(2)());
    expect(
      (await admin!.query("SELECT status, last_error_code FROM email_outbox"))
        .rows,
    ).toContainEqual({
      status: "failed",
      last_error_code: "legacy_signup_retired",
    });
  });

  it("rechecks expiry after hashing and preserves an unconsumed proof on rollback", async () => {
    await migrateDatabase(connectionString!);
    const proof = await ownership();
    let reads = 0;
    expect(
      await completeSignup(admin!, proof, password, () =>
        at(reads++ === 0 ? 1_800 : 1_801)(),
      ),
    ).toEqual({ status: "expired" });
    expect((await admin!.query("SELECT * FROM users")).rows).toEqual([]);
    expect(
      (await admin!.query("SELECT proof_consumed_at FROM auth_signup_attempts"))
        .rows[0].proof_consumed_at,
    ).toBeNull();
  });

  it("serializes concurrent completion and does not overwrite a verified account", async () => {
    await migrateDatabase(connectionString!);
    const proof = await ownership();
    const pool = new Pool({ connectionString, max: 3 });
    try {
      const results = await Promise.all([
        completeSignup(pool, proof, password, at(2)),
        completeSignup(pool, proof, "OtherPass1234", at(2)),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "already_completed",
        "created",
      ]);
      const next = await ownership("owner@example.com", 61);
      expect(
        await completeSignup(pool, next, "ReplacePass123", at(63)),
      ).toEqual({ status: "account_exists" });
      expect((await admin!.query("SELECT * FROM users")).rows).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("rolls back account and proof consumption together on a database failure", async () => {
    await migrateDatabase(connectionString!);
    const proof = await ownership();
    await admin!
      .query(`CREATE FUNCTION reject_signup_password() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced signup password failure'; END $$;
      CREATE TRIGGER reject_signup_password BEFORE INSERT ON auth_identities FOR EACH ROW EXECUTE FUNCTION reject_signup_password()`);
    try {
      await expect(
        completeSignup(admin!, proof, password, at(2)),
      ).rejects.toThrow("forced signup password failure");
      expect((await admin!.query("SELECT * FROM users")).rows).toEqual([]);
      expect(
        (
          await admin!.query(
            "SELECT proof_consumed_at FROM auth_signup_attempts",
          )
        ).rows[0].proof_consumed_at,
      ).toBeNull();
    } finally {
      await admin!.query(
        "DROP TRIGGER reject_signup_password ON auth_identities; DROP FUNCTION reject_signup_password()",
      );
    }
    expect(await completeSignup(admin!, proof, password, at(3))).toEqual({
      status: "created",
    });
  });
});
