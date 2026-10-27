import { describe, expect, it, vi } from "vitest";

import { ResendEmailError, sendResendEmail } from "#api/modules/email/resend";

describe("Resend email delivery", () => {
  it("sends one stable request with the outbox idempotency key", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }),
    );

    await expect(
      sendResendEmail(
        {
          from: "AMUQ <account@example.com>",
          html: '<a href="https://example.com/verify-email?token=opaque">인증</a>',
          idempotencyKey: "auth-email/7a7fbf25-a614-4fa0-968a-d5b9f209da25",
          subject: "AMUQ 이메일 인증",
          text: "https://example.com/verify-email?token=opaque",
          to: "learner@example.com",
        },
        { apiKey: "re_test", fetcher },
      ),
    ).resolves.toEqual({
      providerMessageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        body: JSON.stringify({
          from: "AMUQ <account@example.com>",
          html: '<a href="https://example.com/verify-email?token=opaque">인증</a>',
          subject: "AMUQ 이메일 인증",
          text: "https://example.com/verify-email?token=opaque",
          to: ["learner@example.com"],
        }),
        headers: {
          Authorization: "Bearer re_test",
          "Content-Type": "application/json",
          "Idempotency-Key": "auth-email/7a7fbf25-a614-4fa0-968a-d5b9f209da25",
        },
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    [429, true],
    [500, true],
    [422, false],
  ])(
    "classifies status %i without exposing provider content",
    async (status, retryable) => {
      const fetcher = vi.fn(async () =>
        Response.json(
          { message: "learner@example.com rejected", name: "provider_error" },
          { status },
        ),
      );

      const delivery = sendResendEmail(
        {
          from: "AMUQ <account@example.com>",
          html: "<p>Safe body</p>",
          idempotencyKey: "auth-email/outbox-id",
          subject: "AMUQ",
          text: "Safe body",
          to: "learner@example.com",
        },
        { apiKey: "re_test", fetcher },
      );

      await expect(delivery).rejects.toMatchObject<Partial<ResendEmailError>>({
        code: `resend_${status}`,
        retryable,
      });
      await expect(delivery).rejects.not.toThrow("learner@example.com");
    },
  );

  it.each([
    ["concurrent_idempotent_requests", true],
    ["invalid_idempotent_request", false],
  ])("classifies Resend's %s conflict", async (name, retryable) => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { message: "private provider detail", name },
        { status: 409 },
      ),
    );

    await expect(
      sendResendEmail(
        {
          from: "AMUQ <account@example.com>",
          html: "<p>Safe body</p>",
          idempotencyKey: "auth-email/outbox-id",
          subject: "AMUQ",
          text: "Safe body",
          to: "learner@example.com",
        },
        { apiKey: "re_test", fetcher },
      ),
    ).rejects.toMatchObject<Partial<ResendEmailError>>({
      code: `resend_${name}`,
      retryable,
    });
  });

  it("classifies transport failures without exposing their content", async () => {
    const fetcher = vi.fn(async () =>
      Promise.reject(new Error("learner@example.com connection failed")),
    );

    await expect(
      sendResendEmail(
        {
          from: "AMUQ <account@example.com>",
          html: "<p>Safe body</p>",
          idempotencyKey: "auth-email/outbox-id",
          subject: "AMUQ",
          text: "Safe body",
          to: "learner@example.com",
        },
        { apiKey: "re_test", fetcher },
      ),
    ).rejects.toMatchObject<Partial<ResendEmailError>>({
      code: "resend_network",
      retryable: true,
    });
  });

  it("retries a successful provider response without a message id", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: "" }));

    await expect(
      sendResendEmail(
        {
          from: "AMUQ <account@example.com>",
          html: "<p>Safe body</p>",
          idempotencyKey: "auth-email/outbox-id",
          subject: "AMUQ",
          text: "Safe body",
          to: "learner@example.com",
        },
        { apiKey: "re_test", fetcher },
      ),
    ).rejects.toMatchObject<Partial<ResendEmailError>>({
      code: "resend_invalid_response",
      retryable: true,
    });
  });
});
