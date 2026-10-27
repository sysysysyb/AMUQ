import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#api/db/migrations";
import * as passwords from "#api/modules/auth/password";
import {
  AuthRateLimitExceededError,
  hashRateLimitSubject,
} from "#api/modules/auth/rate-limit";
import {
  authenticatePassword,
  completeGoogleLogin,
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
const admission = {
  clientAddress: "203.0.113.55",
  rateLimitSecret: options.rateLimitSecret,
};

const signupLimits = async () =>
  (
    await admin!.query(
      "SELECT subject_kind, subject_hash, attempt_count, window_started_at, expires_at FROM auth_rate_limits WHERE scope = 'signup' ORDER BY subject_kind, subject_hash",
    )
  ).rows;

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
    [id, await passwords.hashPassword("Attacker12345"), epoch],
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
  it("preserves Google access and the password hash for mixed legacy accounts", async () => {
    await migrateDatabase(connectionString!);
    await completeGoogleLogin(
      admin!,
      { email: "owner@example.com", subject: "google-owner" },
      at(0)(),
    );
    const user = await admin!.query<{ id: string }>("SELECT id FROM users");
    const oldHash = await passwords.hashPassword("Attacker12345");
    await admin!.query(
      "INSERT INTO auth_identities(user_id,provider,password_hash,created_at,updated_at) VALUES($1,'password',$2,$3,$3)",
      [user.rows[0]!.id, oldHash, epoch],
    );
    const proof = await ownership();
    expect(await completeSignup(admin!, proof, password, at(2))).toEqual({
      status: "account_exists",
    });
    expect(
      await completeGoogleLogin(
        admin!,
        { email: "owner@example.com", subject: "google-owner" },
        at(3)(),
      ),
    ).toMatchObject({
      status: "authenticated",
      user: { id: user.rows[0]!.id },
    });
    expect(
      (
        await admin!.query(
          "SELECT password_hash FROM auth_identities WHERE provider='password'",
        )
      ).rows,
    ).toEqual([{ password_hash: oldHash }]);
    expect(
      await authenticatePassword(
        admin!,
        "owner@example.com",
        "Attacker12345",
        at(4)(),
      ),
    ).toBeUndefined();
  });

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

  it("does not hash or consume either completion budget when replaying a consumed proof", async () => {
    await migrateDatabase(connectionString!);
    const proof = await ownership();
    const hash = vi.spyOn(passwords, "hashPassword");
    try {
      expect(
        await completeSignup(admin!, proof, password, at(2), admission),
      ).toEqual({ status: "created" });
      const limits = await signupLimits();
      for (const [kind, value] of [
        ["client_address", admission.clientAddress],
        ["identifier", hashOpaqueToken(proof)],
      ] as const) {
        expect(limits).toContainEqual(
          expect.objectContaining({
            subject_kind: kind,
            subject_hash: hashRateLimitSubject(
              kind,
              `signup-complete:${value}`,
              admission.rateLimitSecret,
            ),
            attempt_count: 1,
          }),
        );
      }
      for (const seconds of [3, 3_603]) {
        expect(
          await completeSignup(
            admin!,
            proof,
            "ChangedPass123",
            at(seconds),
            admission,
          ),
        ).toEqual({ status: "already_completed" });
        expect(await signupLimits()).toEqual(limits);
        expect(hash).toHaveBeenCalledTimes(1);
      }
    } finally {
      hash.mockRestore();
    }
  });

  it.each(["client_address", "identifier"] as const)(
    "enforces the completion %s budget independently before hashing",
    async (kind) => {
      await migrateDatabase(connectionString!);
      const proof = await ownership();
      const otherProof = await ownership("other@example.com");
      const interrupted = new Error("Password hashing interrupted");
      const hash = vi
        .spyOn(passwords, "hashPassword")
        .mockRejectedValue(interrupted);
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          await expect(
            completeSignup(admin!, proof, password, at(2), admission),
          ).rejects.toBe(interrupted);
        }
        const limits = await signupLimits();
        const otherAdmission = {
          ...admission,
          clientAddress: "203.0.113.56",
        };
        const rejected = completeSignup(
          admin!,
          kind === "client_address" ? otherProof : proof,
          password,
          at(3),
          kind === "client_address" ? admission : otherAdmission,
        );
        await expect(rejected).rejects.toBeInstanceOf(
          AuthRateLimitExceededError,
        );
        await expect(rejected).rejects.toMatchObject({
          retryAfterSeconds: 3_599,
        });
        expect(hash).toHaveBeenCalledTimes(5);
        expect(await signupLimits()).toEqual(limits);

        await expect(
          completeSignup(admin!, otherProof, password, at(3), otherAdmission),
        ).rejects.toBe(interrupted);
        expect(hash).toHaveBeenCalledTimes(6);
        expect((await admin!.query("SELECT id FROM users")).rows).toEqual([]);
        expect(
          (
            await admin!.query(
              "SELECT proof_consumed_at FROM auth_signup_attempts",
            )
          ).rows.every((row) => row.proof_consumed_at === null),
        ).toBe(true);
      } finally {
        hash.mockRestore();
      }
    },
  );

  it.each([
    ["just before", 3_601.999, false],
    ["exactly at", 3_602, true],
    ["just after", 3_602.001, true],
  ] as const)(
    "checks completion admission %s the hourly expiry",
    async (_boundary, seconds, allowed) => {
      await migrateDatabase(connectionString!);
      const proof = await ownership();
      const passwordHash = await passwords.hashPassword(password);
      const interrupted = new Error("Password hashing interrupted");
      const hash = vi
        .spyOn(passwords, "hashPassword")
        .mockRejectedValue(interrupted);
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          await expect(
            completeSignup(admin!, proof, password, at(2), admission),
          ).rejects.toBe(interrupted);
        }
        // The original 30-minute proof expires before its IP's hourly budget.
        const freshProof = await ownership("boundary@example.com", 3_500);
        const limits = await signupLimits();
        hash.mockResolvedValue(passwordHash);
        const completion = completeSignup(
          admin!,
          freshProof,
          password,
          at(seconds),
          admission,
        );
        if (!allowed) {
          await expect(completion).rejects.toBeInstanceOf(
            AuthRateLimitExceededError,
          );
          await expect(completion).rejects.toMatchObject({
            retryAfterSeconds: 1,
          });
          expect(await signupLimits()).toEqual(limits);
          expect(hash).toHaveBeenCalledTimes(5);
          expect((await admin!.query("SELECT id FROM users")).rows).toEqual([]);
        } else {
          expect(await completion).toEqual({ status: "created" });
          expect(hash).toHaveBeenCalledTimes(6);
          expect(await signupLimits()).toContainEqual(
            expect.objectContaining({
              subject_kind: "client_address",
              subject_hash: hashRateLimitSubject(
                "client_address",
                `signup-complete:${admission.clientAddress}`,
                admission.rateLimitSecret,
              ),
              attempt_count: 1,
              window_started_at: at(seconds)(),
              expires_at: at(seconds + 3_600)(),
            }),
          );
        }
      } finally {
        hash.mockRestore();
      }
    },
  );

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

  it("lets verified Google ownership recover a legacy account without its password", async () => {
    await migrateDatabase(connectionString!);
    const old = await legacy();
    const result = await completeGoogleLogin(
      admin!,
      {
        email: "owner@example.com",
        subject: "google-owner",
      },
      at(2)(),
    );
    expect(result).toMatchObject({
      status: "authenticated",
      user: { id: old.id },
    });
    expect(
      (await admin!.query("SELECT provider, activated_at FROM auth_identities"))
        .rows,
    ).toEqual([{ provider: "google", activated_at: at(2)() }]);
    expect(
      await authenticatePassword(
        admin!,
        "owner@example.com",
        "Attacker12345",
        at(3)(),
      ),
    ).toBeUndefined();
  });

  it("protects active passwords and requires Google proof before activating an added password", async () => {
    await migrateDatabase(connectionString!);
    await completeGoogleLogin(
      admin!,
      {
        email: "owner@example.com",
        subject: "google-owner",
      },
      epoch,
    );
    const proof = await ownership();
    const result = await completeSignup(admin!, proof, password, at(2));
    expect(result).toMatchObject({
      status: "account_link_required",
      requiredProvider: "google",
    });
    expect(
      await authenticatePassword(
        admin!,
        "owner@example.com",
        password,
        at(3)(),
      ),
    ).toMatchObject({
      status: "account_link_required",
      requiredProvider: "google",
    });
    expect(
      (await admin!.query("SELECT * FROM auth_sessions")).rows,
    ).toHaveLength(1);
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

  it.each(["google_first", "password_first"] as const)(
    "serializes %s legacy recovery without activating the losing identity",
    async (order) => {
      await migrateDatabase(connectionString!);
      const old = await legacy();
      const proof = await ownership();
      const pool = new Pool({
        connectionString,
        max: 4,
        application_name: "signup-google-race",
      });
      const blocker = await pool.connect();
      let google: ReturnType<typeof completeGoogleLogin> | undefined;
      let signup: ReturnType<typeof completeSignup> | undefined;
      const googleRequest = () =>
        completeGoogleLogin(
          pool,
          { email: "owner@example.com", subject: "google-owner" },
          at(2)(),
        );
      const signupRequest = () => completeSignup(pool, proof, password, at(2));
      const waitForQueued = (count: number) =>
        vi.waitFor(
          async () => {
            const result = await admin!.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='signup-google-race' AND wait_event_type='Lock'",
            );
            expect(result.rows[0].count).toBe(count);
          },
          { timeout: 3_000, interval: 10 },
        );
      try {
        await blocker.query(
          "SELECT pg_advisory_lock(hashtextextended('amuq:google-identity', 0))",
        );
        if (order === "google_first") google = googleRequest();
        else signup = signupRequest();
        await waitForQueued(1);
        if (order === "google_first") signup = signupRequest();
        else google = googleRequest();
        await waitForQueued(2);
        await blocker.query(
          "SELECT pg_advisory_unlock(hashtextextended('amuq:google-identity', 0))",
        );
        const [googleResult, signupResult] = await Promise.all([
          google!,
          signup!,
        ]);
        expect(googleResult.status).toBe(
          order === "google_first" ? "authenticated" : "account_link_required",
        );
        expect(signupResult.status).toBe(
          order === "google_first" ? "account_link_required" : "created",
        );
        const identities = await admin!.query(
          "SELECT provider, activated_at FROM auth_identities ORDER BY provider",
        );
        expect(
          identities.rows.filter((identity) => identity.activated_at !== null),
        ).toEqual([
          {
            provider: order === "google_first" ? "google" : "password",
            activated_at: at(2)(),
          },
        ]);
        expect((await admin!.query("SELECT id FROM users")).rows).toEqual([
          { id: old.id },
        ]);
        expect(
          await authenticatePassword(
            pool,
            "owner@example.com",
            "Attacker12345",
            at(3)(),
          ),
        ).toBeUndefined();
      } finally {
        await blocker.query(
          "SELECT pg_advisory_unlock(hashtextextended('amuq:google-identity', 0))",
        );
        await Promise.allSettled([google, signup].filter(Boolean));
        blocker.release();
        await pool.end();
      }
    },
  );
});
