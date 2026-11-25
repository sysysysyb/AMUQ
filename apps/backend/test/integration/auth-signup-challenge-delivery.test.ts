import { expect, it, vi } from "vitest";

import { migrateDatabase } from "#backend/db/migrations";
import { deliverPendingEmails } from "#backend/jobs/send-email";
import { verifySignupChallenge } from "#backend/modules/auth/signup-challenge";
import { ResendEmailError } from "#backend/modules/email/resend";
import { authTokenSecret } from "#backend-test/support/auth-database";
import { setupSignupChallenge } from "#backend-test/support/auth-signup-challenge";

const {
  admin,
  connectionString,
  options,
  at,
  start,
  codeFor,
  deliver,
  databaseTest,
} = setupSignupChallenge();

databaseTest("signup ownership challenge", () => {
  it("delivers the same secret-derived six-digit payload after a lost response and key rotation", async () => {
    await migrateDatabase(connectionString!);
    const challenge = await start();
    const code = await codeFor(challenge.attemptToken);
    const sendEmail = vi
      .fn()
      .mockRejectedValueOnce(new ResendEmailError("request_timeout", true))
      .mockResolvedValueOnce({ providerMessageId: "signup-message" });
    expect(await deliver(sendEmail)).toEqual({
      failed: 0,
      retrying: 1,
      sent: 0,
    });
    expect(await deliver(sendEmail, 62, "b".repeat(32))).toEqual({
      failed: 0,
      retrying: 0,
      sent: 1,
    });
    expect(sendEmail.mock.calls[0]![0]).toEqual(sendEmail.mock.calls[1]![0]);
    expect(sendEmail.mock.calls[0]![0].text).toContain(code);
    expect(sendEmail.mock.calls[0]![0].text).toContain("10분");
    expect(sendEmail.mock.calls[0]![0].text).not.toContain("verify-email");
  });

  it("does not send codes revoked or verified before delivery", async () => {
    await migrateDatabase(connectionString!);
    const first = await start();
    const second = await start(60);
    await verifySignupChallenge(
      admin!,
      second.attemptToken,
      await codeFor(second.attemptToken),
      options,
      at(61),
    );
    const sendEmail = vi.fn();
    expect(await deliver(sendEmail, 62)).toEqual({
      failed: 1,
      retrying: 0,
      sent: 0,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      await verifySignupChallenge(
        admin!,
        first.attemptToken,
        "000000",
        options,
        at(62),
      ),
    ).toMatchObject({ status: "invalid_challenge" });
  });

  it("retires expired signup mail without calling its provider", async () => {
    await migrateDatabase(connectionString!);
    await start();
    const sendEmail = vi.fn();
    expect(await deliver(sendEmail, 600)).toEqual({
      failed: 1,
      retrying: 0,
      sent: 0,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      (await admin!.query("SELECT status, last_error_code FROM email_outbox"))
        .rows,
    ).toEqual([{ status: "failed", last_error_code: "token_expired" }]);
  });

  it("does not send or overwrite a signup mail reclaimed during payload preparation", async () => {
    await migrateDatabase(connectionString!);
    await start();
    let seconds = 1;
    const database = {
      executeSql: async (sql: string, values?: unknown[]) => {
        const result = await admin!.query(sql, values);
        if (sql.includes("SET payload_hash = $2")) {
          await admin!.query("UPDATE email_outbox SET updated_at = $1", [
            at(2)(),
          ]);
          seconds = 3;
        }
        return result;
      },
    };
    const sendEmail = vi.fn();
    expect(
      await deliverPendingEmails(database, {
        authTokenSecret,
        clock: () => at(seconds)(),
        from: "AMUQ <account@example.com>",
        sendEmail,
        webOrigin: "https://example.com",
      }),
    ).toEqual({ failed: 0, retrying: 0, sent: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(
      (await admin!.query("SELECT status, updated_at FROM email_outbox")).rows,
    ).toEqual([{ status: "pending", updated_at: at(2)() }]);
  });

  it("does not log signup code or bearer credentials", async () => {
    await migrateDatabase(connectionString!);
    const spies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      const challenge = await start();
      const code = await codeFor(challenge.attemptToken);
      const verified = await verifySignupChallenge(
        admin!,
        challenge.attemptToken,
        code,
        options,
        at(1),
      );
      if (verified.status !== "verified")
        throw new Error("Expected verified proof");
      const logs = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      for (const credential of [
        code,
        challenge.attemptToken,
        verified.signupProof,
      ])
        expect(logs).not.toContain(credential);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
