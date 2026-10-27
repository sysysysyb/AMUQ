import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  applicationEnvironment,
  authApiConfig,
  googleOidcConfig,
  proxySharedSecret,
  resendWebhookSecret,
} from "#api/config/environment";

describe("application environment", () => {
  it("retains a validated previous signup signing key during rotation", () => {
    const config = {
      AMUQ_ENV: "development",
      WEB_ORIGIN: "http://localhost:3000",
      AUTH_TOKEN_SECRET: "a".repeat(32),
      AUTH_RATE_LIMIT_SECRET: "r".repeat(32),
      AUTH_TOKEN_PREVIOUS_SECRET: "p".repeat(32),
    };
    expect(authApiConfig(config)).toHaveProperty(
      "authTokenPreviousSecret",
      "p".repeat(32),
    );
    expect(() =>
      authApiConfig({ ...config, AUTH_TOKEN_PREVIOUS_SECRET: "short" }),
    ).toThrow("AUTH_TOKEN_PREVIOUS_SECRET must be at least 32 bytes");
  });
  it("requires a Resend webhook secret in production and allows missing local configuration", () => {
    expect(() => resendWebhookSecret({ AMUQ_ENV: "production" })).toThrow(
      "RESEND_WEBHOOK_SECRET is required in production",
    );
    expect(resendWebhookSecret({ AMUQ_ENV: "development" })).toBeUndefined();
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    expect(
      resendWebhookSecret({
        AMUQ_ENV: "production",
        RESEND_WEBHOOK_SECRET: secret,
      }),
    ).toBe(secret);
  });

  it.each(["not-a-signing-secret", "whsec_!!!", "whsec_YQ=="])(
    "rejects malformed signing configuration: %s",
    (secret) => {
      expect(() =>
        resendWebhookSecret({
          AMUQ_ENV: "development",
          RESEND_WEBHOOK_SECRET: secret,
        }),
      ).toThrow("RESEND_WEBHOOK_SECRET must be a valid whsec_ signing secret");
    },
  );
  it.each(["development", "test", "production"] as const)(
    "accepts the %s environment",
    (value) => {
      expect(applicationEnvironment({ AMUQ_ENV: value })).toBe(value);
    },
  );

  it.each([undefined, "", "preview", "Production"])(
    "rejects an invalid environment value: %s",
    (value) => {
      expect(() => applicationEnvironment({ AMUQ_ENV: value })).toThrow(
        "AMUQ_ENV must be development, test, or production",
      );
    },
  );

  it("requires the proxy shared secret in production", () => {
    expect(() => proxySharedSecret({ AMUQ_ENV: "production" })).toThrow(
      "PROXY_SHARED_SECRET is required in production",
    );
  });

  it("reads the configured proxy shared secret", () => {
    expect(
      proxySharedSecret({
        AMUQ_ENV: "production",
        PROXY_SHARED_SECRET: "shared-secret",
      }),
    ).toBe("shared-secret");
  });

  it("does not require a proxy shared secret outside production", () => {
    expect(proxySharedSecret({ AMUQ_ENV: "test" })).toBeUndefined();
  });

  it("uses only configured origins and adds API_ORIGIN outside production", () => {
    expect(
      authApiConfig({
        AMUQ_ENV: "development",
        API_ORIGIN: "http://localhost:3001",
        AUTH_RATE_LIMIT_SECRET: "r".repeat(32),
        AUTH_TOKEN_SECRET: "a".repeat(32),
        WEB_ORIGIN: "http://localhost:3000",
      }),
    ).toEqual({
      allowedOrigins: ["http://localhost:3000", "http://localhost:3001"],
      authTokenSecret: "a".repeat(32),
      rateLimitSecret: "r".repeat(32),
      webOrigin: "http://localhost:3000",
    });
  });

  it("rejects weak secrets, path origins, and production API_ORIGIN", () => {
    const valid = {
      AMUQ_ENV: "production",
      AUTH_RATE_LIMIT_SECRET: "r".repeat(32),
      AUTH_TOKEN_SECRET: "a".repeat(32),
      WEB_ORIGIN: "https://example.com",
    };

    expect(() =>
      authApiConfig({ ...valid, AUTH_RATE_LIMIT_SECRET: "short" }),
    ).toThrow("AUTH_RATE_LIMIT_SECRET must be at least 32 bytes");
    expect(() =>
      authApiConfig({ ...valid, WEB_ORIGIN: "https://example.com/path" }),
    ).toThrow(
      "WEB_ORIGIN must be an HTTP origin without credentials or a path",
    );
    expect(() =>
      authApiConfig({ ...valid, API_ORIGIN: "https://api.example.com" }),
    ).toThrow("API_ORIGIN is allowed only in development");
  });

  it("loads Google OIDC only when all provider values are configured", () => {
    expect(
      googleOidcConfig({
        AMUQ_ENV: "development",
        GOOGLE_OIDC_CLIENT_ID: "client-id",
        GOOGLE_OIDC_CLIENT_SECRET: "client-secret",
        GOOGLE_OIDC_REDIRECT_URI: "http://localhost:3001/auth/google/callback",
      }),
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:3001/auth/google/callback",
    });
    expect(googleOidcConfig({ AMUQ_ENV: "development" })).toBeUndefined();
  });

  it("rejects partial or unsafe Google OIDC configuration", () => {
    expect(() =>
      googleOidcConfig({
        AMUQ_ENV: "development",
        GOOGLE_OIDC_CLIENT_ID: "client-id",
      }),
    ).toThrow("Google OIDC configuration must include all three values");

    expect(() =>
      googleOidcConfig({
        AMUQ_ENV: "production",
        WEB_ORIGIN: "https://web.example.com",
        GOOGLE_OIDC_CLIENT_ID: "client-id",
        GOOGLE_OIDC_CLIENT_SECRET: "client-secret",
        GOOGLE_OIDC_REDIRECT_URI: "http://example.com/auth/google/callback",
      }),
    ).toThrow("GOOGLE_OIDC_REDIRECT_URI must use HTTPS in production");

    expect(() =>
      googleOidcConfig({
        AMUQ_ENV: "production",
        WEB_ORIGIN: "https://web.example.com",
        GOOGLE_OIDC_CLIENT_ID: "client-id",
        GOOGLE_OIDC_CLIENT_SECRET: "client-secret",
        GOOGLE_OIDC_REDIRECT_URI:
          "https://api.example.com/auth/google/callback",
      }),
    ).toThrow(
      "GOOGLE_OIDC_REDIRECT_URI must use the WEB_ORIGIN /api proxy in production",
    );

    expect(
      googleOidcConfig({
        AMUQ_ENV: "production",
        WEB_ORIGIN: "https://web.example.com",
        GOOGLE_OIDC_CLIENT_ID: "client-id",
        GOOGLE_OIDC_CLIENT_SECRET: "client-secret",
        GOOGLE_OIDC_REDIRECT_URI:
          "https://web.example.com/api/auth/google/callback",
      }),
    ).toMatchObject({
      redirectUri: "https://web.example.com/api/auth/google/callback",
    });

    expect(() =>
      googleOidcConfig({
        AMUQ_ENV: "development",
        GOOGLE_OIDC_CLIENT_ID: "client-id",
        GOOGLE_OIDC_CLIENT_SECRET: "client-secret",
        GOOGLE_OIDC_REDIRECT_URI:
          "http://user:pass@localhost:3001/auth/google/callback?leak=true",
      }),
    ).toThrow("GOOGLE_OIDC_REDIRECT_URI must be a safe HTTP URL");
  });

  it("requires Google OIDC configuration in production", () => {
    expect(() => googleOidcConfig({ AMUQ_ENV: "production" })).toThrow(
      "Google OIDC configuration is required in production",
    );
  });

  it("keeps example environment values empty", () => {
    const example = readFileSync(
      new URL("../../../../.env.example", import.meta.url),
      "utf8",
    );
    const assignments = example
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"));

    expect(assignments).toEqual([
      "AMUQ_ENV=",
      "HOST=",
      "PORT=",
      "API_ORIGIN=",
      "PROXY_SHARED_SECRET=",
      "POSTGRES_PASSWORD=",
      "DATABASE_URL=",
      "TEST_DATABASE_URL=",
      "WEB_ORIGIN=",
      "AUTH_TOKEN_SECRET=",
      "AUTH_TOKEN_PREVIOUS_SECRET=",
      "AUTH_RATE_LIMIT_SECRET=",
      "GOOGLE_OIDC_CLIENT_ID=",
      "GOOGLE_OIDC_CLIENT_SECRET=",
      "GOOGLE_OIDC_REDIRECT_URI=",
      "RESEND_API_KEY=",
      "RESEND_WEBHOOK_SECRET=",
      "RESEND_FROM_EMAIL=",
      "R2_ACCOUNT_ID=",
      "R2_BUCKET_NAME=",
      "R2_ACCESS_KEY_ID=",
      "R2_SECRET_ACCESS_KEY=",
      "NEXT_PUBLIC_POSTHOG_KEY=",
      "NEXT_PUBLIC_POSTHOG_HOST=",
      "SENTRY_DSN=",
      "NEXT_PUBLIC_SENTRY_DSN=",
      "SENTRY_AUTH_TOKEN=",
      "SENTRY_ORG=",
      "SENTRY_PROJECT=",
    ]);
  });
});
