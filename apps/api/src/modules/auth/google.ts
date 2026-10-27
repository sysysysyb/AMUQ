import { timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import type { GoogleOidcConfig } from "#api/config/environment";
import { hashOpaqueToken } from "#api/modules/auth/token";

const googleAuthorizationEndpoint =
  "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenEndpoint = "https://oauth2.googleapis.com/token";
const googleJwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

export interface GoogleAuthorizationParameters {
  codeChallenge: string;
  nonce: string;
  state: string;
}

export interface GoogleIdentity {
  email: string;
  subject: string;
}

export const buildGoogleAuthorizationUrl = (
  config: GoogleOidcConfig,
  parameters: GoogleAuthorizationParameters,
): string => {
  const url = new URL(googleAuthorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    code_challenge: parameters.codeChallenge,
    code_challenge_method: "S256",
    nonce: parameters.nonce,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email",
    state: parameters.state,
  }).toString();
  return url.href;
};

export const safeReturnTo = (value: string | undefined): string => {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/";
  }
  const base = new URL("https://application.invalid");
  const resolved = new URL(value, base);
  return resolved.origin === base.origin
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : "/";
};

export const exchangeGoogleAuthorizationCode = async (
  config: GoogleOidcConfig,
  code: string,
  codeVerifier: string,
  expectedNonceHash: string,
  fetcher: typeof fetch = fetch,
  keySet: JWTVerifyGetKey = googleJwks,
): Promise<GoogleIdentity> => {
  const response = await fetcher(googleTokenEndpoint, {
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error("Google authorization code exchange failed");
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    !body ||
    !("id_token" in body) ||
    typeof body.id_token !== "string"
  ) {
    throw new Error("Google token response is invalid");
  }
  return verifyGoogleIdToken(
    body.id_token,
    config.clientId,
    expectedNonceHash,
    keySet,
  );
};

export const verifyGoogleIdToken = async (
  idToken: string,
  clientId: string,
  expectedNonceHash: string,
  keySet: JWTVerifyGetKey = googleJwks,
): Promise<GoogleIdentity> => {
  const { payload } = await jwtVerify(idToken, keySet, {
    algorithms: ["RS256"],
    audience: clientId,
    issuer: ["accounts.google.com", "https://accounts.google.com"],
  });
  if (
    typeof payload.nonce !== "string" ||
    !equalHash(hashOpaqueToken(payload.nonce), expectedNonceHash)
  ) {
    throw new Error("Google ID token nonce is invalid");
  }
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !payload.email ||
    payload.email_verified !== true
  ) {
    throw new Error("Google ID token identity is invalid");
  }
  return { email: payload.email.trim().toLowerCase(), subject: payload.sub };
};

const equalHash = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
};
