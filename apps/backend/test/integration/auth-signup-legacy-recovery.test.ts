import { Pool } from "pg";
import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import * as passwords from "#backend/modules/auth/password";
import {
  authenticatePassword,
  completeGoogleLogin,
  completeSignup,
  issueAuthToken,
  retireLegacySignupTokens,
} from "#backend/modules/auth/service";
import { authTokenSecret } from "#backend-test/support/auth-database";
import { setupSignupCompletion } from "#backend-test/support/auth-signup-completion";

const {
  admin,
  connectionString,
  epoch,
  at,
  password,
  ownership,
  databaseTest,
} = setupSignupCompletion();

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
