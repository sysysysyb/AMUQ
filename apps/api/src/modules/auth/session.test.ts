import { describe, expect, it } from "vitest";

import {
  accountLinkCookieName,
  clearAccountLinkCookie,
  clearPasswordResetCookie,
  clearSessionCookie,
  createPasswordResetSession,
  createSession,
  googleOidcFlowCookieName,
  passwordResetCookieName,
  serializeAccountLinkCookie,
  serializeGoogleOidcFlowCookie,
  serializePasswordResetCookie,
  serializeSessionCookie,
} from "#api/modules/auth/session";

const dayMs = 24 * 60 * 60 * 1_000;
const start = new Date("2026-09-01T00:00:00.000Z");

describe("authentication sessions", () => {
  it("creates a 7-day idle and 30-day absolute session", () => {
    const session = createSession(start);

    expect(session.rawToken).not.toBe(session.tokenHash);
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.createdAt).toEqual(start);
    expect(session.lastSeenAt).toEqual(start);
    expect(session.idleExpiresAt).toEqual(
      new Date(start.getTime() + 7 * dayMs),
    );
    expect(session.absoluteExpiresAt).toEqual(
      new Date(start.getTime() + 30 * dayMs),
    );
  });

  it("serializes only a secure host-bound session cookie", () => {
    const cookie = serializeSessionCookie("raw-session-token");

    expect(cookie).toBe(
      "__Host-session=raw-session-token; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
    expect(cookie).not.toMatch(/Domain=/i);
    expect(clearSessionCookie()).toBe(
      "__Host-session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("creates a 15-minute password-reset session and a strict host cookie", () => {
    const session = createPasswordResetSession(start);

    expect(session.rawToken).not.toBe(session.tokenHash);
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.createdAt).toEqual(start);
    expect(session.expiresAt).toEqual(
      new Date(start.getTime() + 15 * 60 * 1_000),
    );
    expect(passwordResetCookieName).toBe("__Host-password-reset");
    expect(serializePasswordResetCookie(session.rawToken)).toBe(
      `__Host-password-reset=${session.rawToken}; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(clearPasswordResetCookie()).toBe(
      "__Host-password-reset=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict",
    );
  });

  it("keeps the 10-minute OIDC flow in a cross-site callback cookie", () => {
    const firstName = googleOidcFlowCookieName("first-state");
    const secondName = googleOidcFlowCookieName("second-state");

    expect(firstName).toMatch(/^__Host-google-oauth-[0-9a-f]{32}$/);
    expect(secondName).not.toBe(firstName);
    expect(serializeGoogleOidcFlowCookie("flow-token", "first-state")).toBe(
      `${firstName}=flow-token; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("keeps the 10-minute account-link proof in a restricted host cookie", () => {
    expect(accountLinkCookieName).toBe("__Host-account-link");
    expect(serializeAccountLinkCookie("link-token")).toBe(
      "__Host-account-link=link-token; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
    expect(clearAccountLinkCookie()).toBe(
      "__Host-account-link=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
  });
});
