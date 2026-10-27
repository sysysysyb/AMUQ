import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  safeReturnTo,
  verifyGoogleIdToken,
} from "#api/modules/auth/google";
import { hashOpaqueToken } from "#api/modules/auth/token";

const config = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:3001/auth/google/callback",
};
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

describe("Google OIDC", () => {
  it("builds an authorization URL with state, nonce, and PKCE", () => {
    const authorizationUrl = new URL(
      buildGoogleAuthorizationUrl(config, {
        codeChallenge: "challenge",
        nonce: "nonce",
        state: "state",
      }),
    );

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
      client_id: "client-id",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      nonce: "nonce",
      redirect_uri: "http://localhost:3001/auth/google/callback",
      response_type: "code",
      scope: "openid email",
      state: "state",
    });
  });

  it.each([
    [undefined, "/"],
    ["/dashboard?tab=recent", "/dashboard?tab=recent"],
    ["https://evil.example/path", "/"],
    ["//evil.example/path", "/"],
    ["/\\evil.example/path", "/"],
  ])("keeps returnTo on the application origin: %s", (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });

  it("exchanges the authorization code with its PKCE verifier", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const keySet = createLocalJWKSet({
      keys: [
        { ...(await exportJWK(keys.publicKey)), alg: "RS256", kid: "test" },
      ],
    });
    const idToken = await signedIdToken(keys.privateKey, {
      aud: config.clientId,
      nonce: "nonce",
    });
    const requests: Array<{ body: string; hasSignal: boolean; url: string }> =
      [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({
        body: String(init?.body),
        hasSignal: init?.signal instanceof AbortSignal,
        url: String(input),
      });
      return new Response(JSON.stringify({ id_token: idToken }), {
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      exchangeGoogleAuthorizationCode(
        config,
        "authorization-code",
        "pkce-verifier",
        hashOpaqueToken("nonce"),
        fetcher,
        keySet,
      ),
    ).resolves.toEqual({ email: "person@example.com", subject: "google-123" });
    expect(requests).toEqual([
      {
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: "authorization-code",
          code_verifier: "pkce-verifier",
          grant_type: "authorization_code",
          redirect_uri: config.redirectUri,
        }).toString(),
        hasSignal: true,
        url: "https://oauth2.googleapis.com/token",
      },
    ]);
  });

  describe("ID token verification", () => {
    let keySet: ReturnType<typeof createLocalJWKSet>;
    let privateKey: SigningKey;
    const invalidIdentity = "Google ID token identity is invalid";

    beforeAll(async () => {
      const keys = await generateKeyPair("RS256", { extractable: true });
      privateKey = keys.privateKey;
      keySet = createLocalJWKSet({
        keys: [
          { ...(await exportJWK(keys.publicKey)), alg: "RS256", kid: "test" },
        ],
      });
    });

    it("accepts a signed token for this client and nonce", async () => {
      const token = await signedIdToken(privateKey, {
        aud: config.clientId,
        nonce: "nonce",
      });

      await expect(
        verifyGoogleIdToken(
          token,
          config.clientId,
          hashOpaqueToken("nonce"),
          keySet,
        ),
      ).resolves.toEqual({
        email: "person@example.com",
        subject: "google-123",
      });
    });

    it.each([
      ["unverified email", { email_verified: false }, invalidIdentity],
      ["missing email", { email: undefined }, invalidIdentity],
      ["empty email", { email: "" }, invalidIdentity],
      ["missing subject", { sub: undefined }, invalidIdentity],
      ["empty subject", { sub: "" }, invalidIdentity],
      [
        "untrusted issuer",
        { iss: "https://issuer.example" },
        'unexpected "iss" claim value',
      ],
    ] satisfies [string, Record<string, unknown>, string][])(
      "rejects a correctly signed token with %s",
      async (_condition, overrides, expectedMessage) => {
        const token = await signedIdToken(
          privateKey,
          { aud: config.clientId, nonce: "nonce" },
          overrides,
        );

        await expect(
          verifyGoogleIdToken(
            token,
            config.clientId,
            hashOpaqueToken("nonce"),
            keySet,
          ),
        ).rejects.toThrow(expectedMessage);
      },
    );

    it("rejects a token with the wrong audience or nonce", async () => {
      const wrongAudience = await signedIdToken(privateKey, {
        aud: "another-client",
        nonce: "nonce",
      });
      const wrongNonce = await signedIdToken(privateKey, {
        aud: config.clientId,
        nonce: "another-nonce",
      });

      await expect(
        verifyGoogleIdToken(
          wrongAudience,
          config.clientId,
          hashOpaqueToken("nonce"),
          keySet,
        ),
      ).rejects.toThrow();
      await expect(
        verifyGoogleIdToken(
          wrongNonce,
          config.clientId,
          hashOpaqueToken("nonce"),
          keySet,
        ),
      ).rejects.toThrow("Google ID token nonce is invalid");
    });
  });
});

const signedIdToken = async (
  privateKey: SigningKey,
  claims: { aud: string; nonce: string },
  overrides: Record<string, unknown> = {},
) => {
  return new SignJWT({
    email: "person@example.com",
    email_verified: true,
    iss: "https://accounts.google.com",
    nonce: claims.nonce,
    sub: "google-123",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
};
