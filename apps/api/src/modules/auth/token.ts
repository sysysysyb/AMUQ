import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

export type AuthTokenPurpose = "email_verification" | "password_reset";

const tokenLifetimeMs: Record<AuthTokenPurpose, number> = {
  email_verification: 24 * 60 * 60 * 1_000,
  password_reset: 30 * 60 * 1_000,
};

export interface AuthTokenMaterial {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  rawToken: string;
  tokenHash: string;
}

export const createOpaqueToken = (): string => {
  return randomBytes(32).toString("base64url");
};

export const hashOpaqueToken = (rawToken: string): string => {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
};

export const deriveAuthToken = (
  purpose: AuthTokenPurpose,
  tokenId: string,
  secret: string,
): string => {
  return createHmac("sha256", secret)
    .update(`${purpose}:${tokenId}`, "utf8")
    .digest("base64url");
};

export const authTokenKeyId = (secret: string): string => {
  return createHmac("sha256", secret)
    .update("amuq:auth-token-key", "utf8")
    .digest("hex")
    .slice(0, 16);
};

export const authTokenSecretFor = (
  keyId: string | null,
  options: { authTokenSecret: string; authTokenPreviousSecret?: string },
): string | undefined => {
  for (const secret of [
    options.authTokenSecret,
    options.authTokenPreviousSecret,
  ]) {
    if (secret && authTokenKeyId(secret) === keyId) return secret;
  }
  return undefined;
};

export const createAuthToken = (
  purpose: AuthTokenPurpose,
  secret: string,
  createdAt = new Date(),
  id = randomUUID(),
): AuthTokenMaterial => {
  const rawToken = deriveAuthToken(purpose, id, secret);
  return {
    createdAt,
    expiresAt: new Date(createdAt.getTime() + tokenLifetimeMs[purpose]),
    id,
    rawToken,
    tokenHash: hashOpaqueToken(rawToken),
  };
};
