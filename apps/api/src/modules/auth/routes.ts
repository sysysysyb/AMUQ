import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { GoogleOidcConfig } from "#api/config/environment";
import { type GoogleIdentity } from "#api/modules/auth/google";
import { AuthRateLimitExceededError } from "#api/modules/auth/rate-limit";
import { completeSignup } from "#api/modules/auth/service";
import { serializeAccountLinkCookie } from "#api/modules/auth/session";
import {
  issueSignupChallenge,
  resendSignupChallenge,
  SignupChallengeExpiredError,
  SignupRequestError,
  verifySignupChallenge,
} from "#api/modules/auth/signup-challenge";

export interface AuthRoutesOptions {
  clock?: () => Date;
  allowedOrigins: string[];
  authTokenSecret: string;
  authTokenPreviousSecret?: string;
  database: Pool;
  googleCodeExchange?: (
    config: GoogleOidcConfig,
    code: string,
    codeVerifier: string,
    nonceHash: string,
  ) => Promise<GoogleIdentity>;
  googleOidc?: GoogleOidcConfig;
  rateLimitSecret: string;
  webOrigin: string;
}

const anonymousResponseFloorMilliseconds = 250;

const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
  },
} as const;
const emailBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: { email: { type: "string", format: "email", maxLength: 254 } },
} as const;
const passwordProperty = {
  type: "string",
  minLength: 12,
  maxLength: 128,
} as const;
const newPasswordProperty = {
  ...passwordProperty,
  maxLength: 20,
  pattern: "(?=[\\s\\S]*[A-Z])(?=[\\s\\S]*[a-z])(?=[\\s\\S]*[0-9])",
} as const;
const tokenBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["token"],
  properties: {
    token: { type: "string", minLength: 20, maxLength: 256 },
  },
} as const;
const rateLimitSchema = {
  ...errorSchema,
  description: "Request limit exceeded",
  headers: {
    "Retry-After": {
      description: "Seconds until this request may be retried",
      type: "integer",
      minimum: 1,
    },
  },
} as const;
const originHeadersSchema = {
  type: "object",
  required: ["origin"],
  properties: { origin: { type: "string", format: "uri" } },
} as const;

export const registerAuthRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  server,
  options,
) => {
  const allowedOrigins = new Set(options.allowedOrigins);
  const clock = options.clock ?? (() => new Date());
  const mutationOptions = {
    authTokenSecret: options.authTokenSecret,
    ...(options.authTokenPreviousSecret
      ? { authTokenPreviousSecret: options.authTokenPreviousSecret }
      : {}),
    rateLimitSecret: options.rateLimitSecret,
  };

  server.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");

    if (
      request.method !== "GET" &&
      !allowedOrigins.has(request.headers.origin ?? "")
    ) {
      return reply.code(403).send({
        code: "origin_not_allowed",
        message: "허용되지 않은 요청 출처입니다.",
      });
    }
  });

  server.setErrorHandler((error, request, reply) => {
    if (
      error instanceof SignupRequestError ||
      error instanceof SignupChallengeExpiredError
    ) {
      return reply.code(400).send({
        code: "invalid_or_expired_challenge",
        message: "인증을 다시 진행해 주세요.",
      });
    }
    if (error instanceof AuthRateLimitExceededError) {
      return reply
        .header("retry-after", String(error.retryAfterSeconds))
        .code(429)
        .send({
          code: "rate_limit_exceeded",
          message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        });
    }
    if (
      typeof error === "object" &&
      error &&
      (("code" in error && error.code === "FST_ERR_CTP_INVALID_JSON_BODY") ||
        "validation" in error)
    ) {
      return reply.code(400).send({
        code: "invalid_request",
        message: "요청을 확인해 주세요.",
      });
    }
    request.log.error(
      {
        authFailure: "unexpected",
        errorName: error instanceof Error ? error.name : "UnknownError",
        requestId: request.id,
      },
      "Authentication request failed",
    );
    return reply.code(500).send({
      code: "internal_error",
      message: "요청을 처리하지 못했습니다.",
    });
  });

  for (const url of [
    "/auth/signup",
    "/auth/verify-email",
    "/auth/resend-verification",
  ]) {
    server.post(
      url,
      {
        schema: {
          headers: originHeadersSchema,
          response: { 410: errorSchema, 403: errorSchema },
        },
      },
      async (_request, reply) =>
        reply.code(410).send({
          code: "signup_flow_retired",
          message: "가입 화면에서 이메일 인증을 다시 진행해 주세요.",
        }),
    );
  }

  const operationKeyProperty = { type: "string", format: "uuid" } as const;
  const attemptTokenProperty = tokenBodySchema.properties.token;
  const challengeSchema = {
    type: "object",
    additionalProperties: false,
    required: ["status", "attemptToken", "codeExpiresAt", "resendAvailableAt"],
    properties: {
      status: { type: "string", const: "accepted" },
      attemptToken: attemptTokenProperty,
      codeExpiresAt: { type: "string", format: "date-time" },
      resendAvailableAt: { type: "string", format: "date-time" },
    },
  } as const;
  const signupResultSchema = {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: {
        type: "string",
        enum: [
          "verified",
          "invalid_code",
          "expired",
          "attempts_exhausted",
          "invalid_challenge",
          "invalid_proof",
          "already_completed",
          "created",
          "account_exists",
          "account_link_required",
        ],
      },
      signupProof: { type: "string" },
      proofExpiresAt: { type: "string", format: "date-time" },
      remainingAttempts: { type: "integer", minimum: 0, maximum: 5 },
      requiredProvider: { type: "string", enum: ["google"] },
    },
  } as const;
  const signupErrors = {
    400: errorSchema,
    403: errorSchema,
    429: rateLimitSchema,
    500: errorSchema,
  };
  server.post<{ Body: { email: string; operationKey: string } }>(
    "/auth/signup/challenges",
    {
      schema: {
        operationId: "issueSignupChallenge",
        headers: originHeadersSchema,
        body: {
          ...emailBodySchema,
          required: ["email", "operationKey"],
          properties: {
            ...emailBodySchema.properties,
            operationKey: operationKeyProperty,
          },
        },
        response: { ...signupErrors, 202: challengeSchema },
      },
    },
    async (request, reply) => {
      const startedAt = performance.now();
      const challenge = await issueSignupChallenge(
        options.database,
        request.body.email,
        request.body.operationKey,
        request.clientAddress,
        mutationOptions,
        clock,
      );
      await waitForAnonymousResponseFloor(startedAt);
      return reply.code(202).send({ status: "accepted", ...challenge });
    },
  );
  server.post<{ Body: { attemptToken: string; operationKey: string } }>(
    "/auth/signup/challenges/resend",
    {
      schema: {
        operationId: "resendSignupChallenge",
        headers: originHeadersSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["attemptToken", "operationKey"],
          properties: {
            attemptToken: attemptTokenProperty,
            operationKey: operationKeyProperty,
          },
        },
        response: { ...signupErrors, 202: challengeSchema },
      },
    },
    async (request, reply) => {
      const challenge = await resendSignupChallenge(
        options.database,
        request.body.attemptToken,
        request.body.operationKey,
        request.clientAddress,
        mutationOptions,
        clock,
      );
      return reply.code(202).send({ status: "accepted", ...challenge });
    },
  );
  server.post<{ Body: { attemptToken: string; code: string } }>(
    "/auth/signup/challenges/verify",
    {
      schema: {
        operationId: "verifySignupChallenge",
        headers: originHeadersSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["attemptToken", "code"],
          properties: {
            attemptToken: attemptTokenProperty,
            code: { type: "string", pattern: "^[0-9]{6}$" },
          },
        },
        response: {
          ...signupErrors,
          200: signupResultSchema,
          400: { anyOf: [errorSchema, signupResultSchema] },
        },
      },
    },
    async (request, reply) => {
      const result = await verifySignupChallenge(
        options.database,
        request.body.attemptToken,
        request.body.code,
        mutationOptions,
        clock,
      );
      return reply.code(result.status === "verified" ? 200 : 400).send(result);
    },
  );
  server.post<{ Body: { signupProof: string; password: string } }>(
    "/auth/signup/complete",
    {
      schema: {
        operationId: "completeSignup",
        headers: originHeadersSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["signupProof", "password"],
          properties: {
            signupProof: attemptTokenProperty,
            password: newPasswordProperty,
          },
        },
        response: {
          ...signupErrors,
          200: signupResultSchema,
          400: { anyOf: [errorSchema, signupResultSchema] },
        },
      },
    },
    async (request, reply) => {
      const result = await completeSignup(
        options.database,
        request.body.signupProof,
        request.body.password,
        clock,
        {
          clientAddress: request.clientAddress,
          rateLimitSecret: options.rateLimitSecret,
        },
      );
      if (result.status === "account_link_required") {
        return reply
          .header(
            "set-cookie",
            serializeAccountLinkCookie(result.linkSessionToken),
          )
          .send({
            status: result.status,
            requiredProvider: result.requiredProvider,
          });
      }
      return reply
        .code(["expired", "invalid_proof"].includes(result.status) ? 400 : 200)
        .send(result);
    },
  );
};

const waitForAnonymousResponseFloor = async (startedAt: number) => {
  const remaining =
    anonymousResponseFloorMilliseconds - (performance.now() - startedAt);
  if (remaining > 0) await delay(remaining);
};
