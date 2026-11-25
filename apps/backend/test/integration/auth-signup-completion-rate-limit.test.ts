import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import * as passwords from "#backend/modules/auth/password";
import {
  AuthRateLimitExceededError,
  hashRateLimitSubject,
} from "#backend/modules/auth/rate-limit";
import { completeSignup } from "#backend/modules/auth/service";
import { hashOpaqueToken } from "#backend/modules/auth/token";
import { setupSignupCompletion } from "#backend-test/support/auth-signup-completion";

const {
  admin,
  connectionString,
  at,
  password,
  ownership,
  options,
  databaseTest,
} = setupSignupCompletion();

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

databaseTest("signup completion ownership", () => {
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
});
