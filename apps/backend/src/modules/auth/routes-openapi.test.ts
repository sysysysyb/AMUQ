import { describe, expect, it } from "vitest";

import { setupAuthHttpServer } from "#backend-test/support/auth-http-server";

const createServer = setupAuthHttpServer();

describe("authentication HTTP boundary", () => {
  it("documents every password route and its stable error contracts", async () => {
    const server = await createServer();
    const document = await server.inject({
      method: "GET",
      url: "/openapi.json",
    });

    expect(document.statusCode).toBe(200);
    expect(Object.keys(document.json().paths)).toEqual(
      expect.arrayContaining([
        "/auth/signup/complete",
        "/auth/verify-email",
        "/auth/resend-verification",
        "/auth/login",
        "/auth/logout",
        "/auth/google/start",
        "/auth/google/callback",
        "/auth/link/status",
        "/auth/link/password",
        "/auth/link/google",
        "/auth/password-reset/request",
        "/auth/password-reset/resend",
        "/auth/password-reset/session",
        "/auth/password-reset/confirm",
        "/account/me",
      ]),
    );
    expect(
      document.json().paths["/auth/signup/challenges"].post.responses["429"]
        .headers,
    ).toMatchObject({
      "Retry-After": {
        description: "Seconds until this request may be retried",
        schema: { minimum: 1, type: "integer" },
      },
    });
    expect(
      document.json().paths["/auth/login"].post.responses["401"].content[
        "application/json"
      ].schema.required,
    ).toEqual(["code", "message"]);
    expect(
      document.json().components.securitySchemes.sessionCookie,
    ).toMatchObject({ in: "cookie", name: "__Host-session", type: "apiKey" });
    expect(
      document.json().components.securitySchemes.passwordResetCookie,
    ).toMatchObject({
      in: "cookie",
      name: "__Host-password-reset",
      type: "apiKey",
    });
    expect(
      document.json().components.securitySchemes.accountLinkCookie,
    ).toMatchObject({
      in: "cookie",
      name: "__Host-account-link",
      type: "apiKey",
    });
    expect(document.json().paths["/account/me"].get.security).toEqual([
      { sessionCookie: [] },
    ]);
    expect(document.json().paths["/auth/google/link"]).toBeUndefined();
    expect(
      document.json().paths["/auth/link/password"].post.responses["429"]
        .headers,
    ).toHaveProperty("Retry-After");
    for (const path of [
      "/auth/link/status",
      "/auth/link/password",
      "/auth/link/google",
    ]) {
      const method = path.endsWith("status") ? "get" : "post";
      expect(document.json().paths[path][method].security).toEqual([
        { accountLinkCookie: [] },
      ]);
    }
    expect(
      document.json().paths["/auth/google/callback"].get.responses["302"],
    ).not.toHaveProperty("content");
    expect(document.json().paths["/auth/login"].post.parameters).toContainEqual(
      expect.objectContaining({ in: "header", name: "origin" }),
    );
    expect(
      document.json().paths["/auth/login"].post.responses["200"].headers,
    ).toMatchObject({
      "Set-Cookie": {
        description:
          "Secure __Host-session or __Host-account-link cookie, depending on the response status",
        schema: { type: "string" },
      },
    });
    expect(
      document.json().paths["/auth/login"].post.responses["429"].headers,
    ).toHaveProperty("Retry-After");
    expect(
      document.json().paths["/auth/password-reset/session"].post.responses[
        "200"
      ].headers,
    ).toHaveProperty("Set-Cookie");
    expect(
      document.json().paths["/auth/password-reset/confirm"].post.requestBody
        .content["application/json"].schema.required,
    ).toEqual(["password"]);
    expect(
      document.json().paths["/auth/password-reset/confirm"].post.security,
    ).toEqual([{ passwordResetCookie: [] }]);
  });
});
