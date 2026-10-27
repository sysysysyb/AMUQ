import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "#api/http/server";
import {
  webhookHeaders,
  webhookPayload,
  webhookSecret,
} from "#api-test/support/resend-webhook";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];
const query = vi.fn().mockResolvedValue({ rows: [{ matched: true }] });

const createServer = async () => {
  const server = await buildServer({
    environment: "test",
    emailWebhook: { database: { query }, secret: webhookSecret },
  });
  servers.push(server);
  return server;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  query.mockReset().mockResolvedValue({ rows: [{ matched: true }] });
});

describe("Resend webhook HTTP boundary", () => {
  it("verifies the exact raw body without browser Origin or session cookies", async () => {
    const server = await createServer();
    const payload = webhookPayload().replace("Fixture subject", "한글 subject");
    const spacedPayload = `  ${payload}\n`;
    const response = await server.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: webhookHeaders(spacedPayload),
      payload: spacedPayload,
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(query.mock.calls)).not.toMatch(
      /webhook-fixture@|Private fixture body|한글 subject/,
    );
  });

  it.each(["svix-id", "svix-timestamp", "svix-signature"] as const)(
    "rejects a missing %s before accessing the database",
    async (name) => {
      const server = await createServer();
      const payload = webhookPayload();
      const headers: Record<string, string> = webhookHeaders(payload);
      delete headers[name];
      const response = await server.inject({
        method: "POST",
        url: "/webhooks/resend",
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(["body", "id", "timestamp", "signature"])(
    "rejects a modified %s",
    async (changed) => {
      const server = await createServer();
      const payload = webhookPayload();
      const headers = webhookHeaders(payload);
      if (changed === "id") headers["svix-id"] = "msg_forged";
      if (changed === "timestamp") headers["svix-timestamp"] = "0";
      if (changed === "signature") headers["svix-signature"] = "v1,forged";
      const response = await server.inject({
        method: "POST",
        url: "/webhooks/resend",
        headers,
        payload: changed === "body" ? `${payload} ` : payload,
      });
      expect(response.statusCode).toBe(400);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([-301_000, 301_000])(
    "rejects a timestamp offset of %s ms",
    async (offset) => {
      const server = await createServer();
      const payload = webhookPayload();
      const response = await server.inject({
        method: "POST",
        url: "/webhooks/resend",
        headers: webhookHeaders(
          payload,
          "msg_fixture",
          new Date(Date.now() + offset),
        ),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("accepts a valid rotation signature among multiple signatures", async () => {
    const server = await createServer();
    const payload = webhookPayload();
    const headers = webhookHeaders(payload);
    headers["svix-signature"] = `v1,invalid ${headers["svix-signature"]}`;
    const response = await server.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers,
      payload,
    });
    expect(response.statusCode).toBe(204);
  });

  it.each([
    "{invalid json",
    "null",
    "[]",
    JSON.stringify({
      type: "email.delivered",
      created_at: "invalid",
      data: {},
    }),
    JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { email_id: "invalid" },
    }),
  ])("rejects a signed malformed payload: %s", async (payload) => {
    const server = await createServer();
    const response = await server.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: webhookHeaders(payload),
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(response.body).not.toContain(payload);
  });

  it("acknowledges tracking events without storing them", async () => {
    const server = await createServer();
    const payload = webhookPayload("email.opened");
    const response = await server.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: webhookHeaders(payload),
      payload,
    });
    expect(response.statusCode).toBe(204);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects oversized requests before verification or database access", async () => {
    const server = await createServer();
    const payload = " ".repeat(64 * 1_024 + 1);
    const response = await server.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: webhookHeaders(payload),
      payload,
    });
    expect(response.statusCode).toBe(413);
    expect(query).not.toHaveBeenCalled();
  });

  it("requests a retry while the provider result is not yet stored", async () => {
    query.mockResolvedValueOnce({ rows: [{ matched: false }] });
    const server = await createServer();
    const payload = webhookPayload();
    const response = await server.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: webhookHeaders(payload),
      payload,
    });
    expect(response.statusCode).toBe(503);
  });

  it("returns a safe retry response on a database failure", async () => {
    query.mockRejectedValueOnce(new Error("Private database failure"));
    const server = await createServer();
    const payload = webhookPayload();
    const response = await server.inject({
      method: "POST",
      url: "/webhooks/resend",
      headers: webhookHeaders(payload),
      payload,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("Private database failure");
  });
});
