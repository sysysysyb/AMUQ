import { Pool } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import {
  authenticatePassword,
  completeSignup,
} from "#backend/modules/auth/service";
import { setupSignupCompletion } from "#backend-test/support/auth-signup-completion";

const { admin, connectionString, at, password, ownership, databaseTest } =
  setupSignupCompletion();

databaseTest("signup completion ownership", () => {
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
