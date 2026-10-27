import { randomUUID } from "node:crypto";

import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#api/db/migrations";
import { buildServer } from "#api/http/server";
import * as passwords from "#api/modules/auth/password";
import { completeGoogleLogin } from "#api/modules/auth/service";
import { deriveSignupCode } from "#api/modules/auth/signup-token";
import { hashOpaqueToken } from "#api/modules/auth/token";
import {
  authTokenSecret,
  setupAuthDatabase,
} from "#api-test/support/auth-database";

const { admin, connectionString, databaseTest } = setupAuthDatabase();
const origin = "https://web.example";
const createServer = (
  signing: { authTokenSecret: string; authTokenPreviousSecret?: string } = {
    authTokenSecret,
  },
) =>
  buildServer({
    environment: "test",
    auth: {
      database: admin!,
      allowedOrigins: [origin],
      webOrigin: origin,
      ...signing,
      rateLimitSecret: "r".repeat(32),
    },
  });

databaseTest("signup HTTP transition", () => {
  it("keeps anonymous challenge responses and unverified login failures indistinguishable", async () => {
    await migrateDatabase(connectionString!);
    await completeGoogleLogin(admin!, {
      email: "existing@example.com",
      subject: "existing-google",
    });
    const legacy = await admin!.query<{ id: string }>(
      "INSERT INTO users(email) VALUES('unverified@example.com') RETURNING id",
    );
    await admin!.query(
      "INSERT INTO auth_identities(user_id,provider,password_hash,activated_at) VALUES($1,'password',$2,now())",
      [legacy.rows[0]!.id, await passwords.hashPassword("OwnerPass1234")],
    );
    const server = await createServer();
    try {
      const bodies: Record<string, unknown>[] = [];
      for (const email of ["new@example.com", "existing@example.com"]) {
        const started = performance.now();
        const response = await server.inject({
          method: "POST",
          url: "/auth/signup/challenges",
          payload: { email, operationKey: randomUUID() },
          headers: { origin },
        });
        expect(response.statusCode).toBe(202);
        expect(performance.now() - started).toBeGreaterThanOrEqual(200);
        const {
          attemptToken,
          codeExpiresAt,
          resendAvailableAt,
          ...publicBody
        } = response.json();
        expect(attemptToken).toEqual(expect.any(String));
        expect(Date.parse(codeExpiresAt)).toBeGreaterThan(Date.now());
        expect(Date.parse(resendAvailableAt)).toBeGreaterThan(Date.now());
        bodies.push(publicBody);
      }
      expect(bodies[0]).toEqual(bodies[1]);
      const failures = [];
      for (const email of ["unverified@example.com", "missing@example.com"]) {
        const response = await server.inject({
          method: "POST",
          url: "/auth/login",
          payload: { email, password: "OwnerPass1234" },
          headers: { origin },
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers["set-cookie"]).toBeUndefined();
        failures.push(response.json());
      }
      expect(failures[0]).toEqual(failures[1]);
    } finally {
      await server.close();
    }
  });

  it("limits concurrent completion hashing before the expensive password work", async () => {
    await migrateDatabase(connectionString!);
    const server = await createServer();
    const post = (url: string, payload: Record<string, unknown>) =>
      server.inject({
        method: "POST",
        url,
        payload,
        headers: { origin },
        remoteAddress: "203.0.113.55",
      });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const passwordHash = await passwords.hashPassword("OwnerPass1234");
    const sent = await post("/auth/signup/challenges", {
      email: "limited@example.com",
      operationKey: randomUUID(),
    });
    const code = await admin!.query<{ id: string }>(
      "SELECT id FROM auth_signup_codes",
    );
    const verified = await post("/auth/signup/challenges/verify", {
      attemptToken: sent.json().attemptToken,
      code: deriveSignupCode(code.rows[0]!.id, authTokenSecret),
    });
    const spy = vi
      .spyOn(passwords, "hashPassword")
      .mockImplementation(async () => {
        await held;
        return passwordHash;
      });
    const statuses: number[] = [];
    const requests = Array.from({ length: 6 }, () =>
      post("/auth/signup/complete", {
        signupProof: verified.json().signupProof,
        password: "OwnerPass1234",
      }).then((response) => {
        statuses.push(response.statusCode);
        return response;
      }),
    );
    try {
      await vi.waitFor(
        () => {
          expect(spy).toHaveBeenCalledTimes(5);
          expect(statuses).toContain(429);
        },
        { timeout: 3_000 },
      );
    } finally {
      release();
      await Promise.all(requests);
      spy.mockRestore();
      await server.close();
    }
  });

  it("verifies an outstanding code through the previous key after API rotation", async () => {
    await migrateDatabase(connectionString!);
    const first = await createServer();
    let attemptToken: string;
    try {
      const sent = await first.inject({
        method: "POST",
        url: "/auth/signup/challenges",
        headers: { origin },
        payload: { email: "rotation@example.com", operationKey: randomUUID() },
      });
      attemptToken = sent.json().attemptToken;
    } finally {
      await first.close();
    }
    const code = await admin!.query<{ id: string }>(
      "SELECT id FROM auth_signup_codes",
    );
    const rotated = await createServer({
      authTokenSecret: "n".repeat(32),
      authTokenPreviousSecret: authTokenSecret,
    });
    try {
      const verified = await rotated.inject({
        method: "POST",
        url: "/auth/signup/challenges/verify",
        headers: { origin },
        payload: {
          attemptToken,
          code: deriveSignupCode(code.rows[0]!.id, authTokenSecret),
        },
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.json().status).toBe("verified");
    } finally {
      await rotated.close();
    }
  });

  it("issues codes without passwords and only completes after verified ownership", async () => {
    await migrateDatabase(connectionString!);
    const server = await createServer();
    const post = (url: string, payload: Record<string, unknown>) =>
      server.inject({
        method: "POST",
        url,
        payload,
        headers: { origin },
        remoteAddress: "203.0.113.1",
      });
    try {
      const operationKey = randomUUID();
      const sent = await post("/auth/signup/challenges", {
        email: "owner@example.com",
        operationKey,
      });
      expect(sent.statusCode).toBe(202);
      expect(sent.headers["cache-control"]).toBe("no-store");
      expect(sent.headers["set-cookie"]).toBeUndefined();
      const { attemptToken } = sent.json();
      expect(
        (
          await post("/auth/signup/challenges", {
            email: "OWNER@example.com",
            operationKey,
          })
        ).json(),
      ).toEqual(sent.json());
      expect((await admin!.query("SELECT * FROM users")).rows).toEqual([]);
      const stored = await admin!.query<{ id: string }>(
        `SELECT code.id FROM auth_signup_codes code JOIN auth_signup_attempts attempt ON code.attempt_id=attempt.id WHERE attempt.token_hash=$1`,
        [hashOpaqueToken(attemptToken)],
      );
      const verified = await post("/auth/signup/challenges/verify", {
        attemptToken,
        code: deriveSignupCode(stored.rows[0]!.id, authTokenSecret),
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({
        status: "verified",
        signupProof: expect.any(String),
        proofExpiresAt: expect.any(String),
      });
      expect((await admin!.query("SELECT * FROM users")).rows).toEqual([]);
      const payload = {
        signupProof: verified.json().signupProof,
        password: "OwnerPass1234",
      };
      const completed = await post("/auth/signup/complete", payload);
      expect(completed.json()).toEqual({ status: "created" });
      expect(completed.headers["set-cookie"]).toBeUndefined();
      expect(
        (
          await post("/auth/signup/complete", {
            ...payload,
            password: "ChangedPass123",
          })
        ).json(),
      ).toEqual({ status: "already_completed" });
      expect(
        (
          await post("/auth/signup/challenges/resend", {
            attemptToken: "x".repeat(30),
            operationKey: randomUUID(),
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("retires old signup routes and rejects forged fields before database writes", async () => {
    await migrateDatabase(connectionString!);
    const server = await createServer();
    try {
      for (const url of [
        "/auth/signup",
        "/auth/verify-email",
        "/auth/resend-verification",
      ]) {
        const response = await server.inject({
          method: "POST",
          url,
          headers: { origin },
          payload: {
            email: "attacker@example.com",
            password: "Attacker12345",
            token: "x".repeat(30),
          },
        });
        expect(response.statusCode).toBe(410);
        expect(response.json().code).toBe("signup_flow_retired");
      }
      for (const payload of [
        {
          email: "owner@example.com",
          operationKey: randomUUID(),
          password: "Attacker12345",
        },
        {
          email: "owner@example.com",
          operationKey: randomUUID(),
          userId: randomUUID(),
        },
      ]) {
        expect(
          (
            await server.inject({
              method: "POST",
              url: "/auth/signup/challenges",
              headers: { origin },
              payload,
            })
          ).statusCode,
        ).toBe(400);
      }
      expect((await admin!.query("SELECT * FROM users")).rows).toEqual([]);
      expect(
        (await admin!.query("SELECT * FROM auth_signup_attempts")).rows,
      ).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
