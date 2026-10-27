import { createHmac } from "node:crypto";

const signupCodeRange = 1_000_000;
const unbiasedSampleUpperBound = 4_294_000_000;

export const deriveSignupAttemptToken = (id: string, secret: string): string =>
  createHmac("sha256", secret)
    .update(`amuq:signup-attempt:${id}`)
    .digest("base64url");

export const deriveSignupCode = (id: string, secret: string): string => {
  for (let counter = 0; ; counter += 1) {
    const value = createHmac("sha256", secret)
      .update(`amuq:signup-code:${id}:${counter}`)
      .digest()
      .readUInt32BE();
    if (value < unbiasedSampleUpperBound)
      return String(value % signupCodeRange).padStart(6, "0");
  }
};

export const digestSignupCode = (
  id: string,
  code: string,
  secret: string,
): string =>
  createHmac("sha256", secret)
    .update(`amuq:signup-code-digest:${id}:${code}`)
    .digest("hex");

export const deriveSignupProof = (
  attemptId: string,
  codeId: string,
  secret: string,
): string =>
  createHmac("sha256", secret)
    .update(`amuq:signup-proof:${attemptId}:${codeId}`)
    .digest("base64url");
