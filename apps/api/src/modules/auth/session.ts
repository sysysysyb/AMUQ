import { createOpaqueToken, hashOpaqueToken } from "#api/modules/auth/token";

export const sessionCookieName = "__Host-session";
export const passwordResetCookieName = "__Host-password-reset";
export const accountLinkCookieName = "__Host-account-link";

const dayMs = 24 * 60 * 60 * 1_000;
const passwordResetSessionLifetimeMs = 15 * 60 * 1_000;
export const googleOidcFlowLifetimeMs = 10 * 60 * 1_000;
export const accountLinkSessionLifetimeMs = 10 * 60 * 1_000;
const idleSessionLifetimeMs = 7 * dayMs;
const absoluteSessionLifetimeMs = 30 * dayMs;

export interface SessionMaterial {
  absoluteExpiresAt: Date;
  createdAt: Date;
  idleExpiresAt: Date;
  lastSeenAt: Date;
  rawToken: string;
  tokenHash: string;
}

export interface PasswordResetSessionMaterial {
  createdAt: Date;
  expiresAt: Date;
  rawToken: string;
  tokenHash: string;
}

export const createSession = (createdAt = new Date()): SessionMaterial => {
  const rawToken = createOpaqueToken();
  return {
    absoluteExpiresAt: new Date(
      createdAt.getTime() + absoluteSessionLifetimeMs,
    ),
    createdAt,
    idleExpiresAt: new Date(createdAt.getTime() + idleSessionLifetimeMs),
    lastSeenAt: createdAt,
    rawToken,
    tokenHash: hashOpaqueToken(rawToken),
  };
};

export const createPasswordResetSession = (
  createdAt = new Date(),
): PasswordResetSessionMaterial => {
  const rawToken = createOpaqueToken();
  return {
    createdAt,
    expiresAt: new Date(createdAt.getTime() + passwordResetSessionLifetimeMs),
    rawToken,
    tokenHash: hashOpaqueToken(rawToken),
  };
};

export const serializeSessionCookie = (rawToken: string): string => {
  return cookieValue(
    sessionCookieName,
    encodeURIComponent(rawToken),
    absoluteSessionLifetimeMs / 1_000,
    "Lax",
  );
};

export const clearSessionCookie = (): string => {
  return cookieValue(sessionCookieName, "", 0, "Lax");
};

export const serializePasswordResetCookie = (rawToken: string): string => {
  return passwordResetCookieValue(
    encodeURIComponent(rawToken),
    passwordResetSessionLifetimeMs / 1_000,
  );
};

export const clearPasswordResetCookie = (): string => {
  return passwordResetCookieValue("", 0);
};

export const serializeAccountLinkCookie = (rawToken: string): string => {
  return cookieValue(
    accountLinkCookieName,
    encodeURIComponent(rawToken),
    accountLinkSessionLifetimeMs / 1_000,
    "Lax",
  );
};

export const clearAccountLinkCookie = (): string => {
  return cookieValue(accountLinkCookieName, "", 0, "Lax");
};

export const googleOidcFlowCookieName = (rawState: string): string => {
  return `__Host-google-oauth-${hashOpaqueToken(rawState).slice(0, 32)}`;
};

export const serializeGoogleOidcFlowCookie = (
  rawToken: string,
  rawState: string,
): string => {
  return cookieValue(
    googleOidcFlowCookieName(rawState),
    encodeURIComponent(rawToken),
    googleOidcFlowLifetimeMs / 1_000,
    "Lax",
  );
};

export const clearGoogleOidcFlowCookie = (rawState: string): string => {
  return cookieValue(googleOidcFlowCookieName(rawState), "", 0, "Lax");
};

const cookieValue = (
  name: string,
  value: string,
  maxAge: number,
  sameSite: "Lax" | "Strict",
): string => {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=${sameSite}`;
};

const passwordResetCookieValue = (value: string, maxAge: number): string => {
  return cookieValue(passwordResetCookieName, value, maxAge, "Strict");
};
