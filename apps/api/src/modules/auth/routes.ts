import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { GoogleOidcConfig } from "#api/config/environment";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  type GoogleIdentity,
  safeReturnTo,
} from "#api/modules/auth/google";
import {
  consumePasswordLoginIp,
  withPasswordLoginAttempt,
} from "#api/modules/auth/login-rate-limit";
import { AuthRateLimitExceededError } from "#api/modules/auth/rate-limit";
import {
  authenticatePassword,
  completeGoogleLink,
  completeGoogleLogin,
  completeSignup,
  consumeGoogleOidcFlow,
  createGoogleLoginFlow,
  exchangePasswordResetToken,
  getAuthenticatedUser,
  requestPasswordReset,
  resetPassword,
  revokeSession,
} from "#api/modules/auth/service";
import {
  accountLinkCookieName,
  clearAccountLinkCookie,
  clearGoogleOidcFlowCookie,
  clearPasswordResetCookie,
  clearSessionCookie,
  googleOidcFlowCookieName,
  passwordResetCookieName,
  serializeAccountLinkCookie,
  serializeGoogleOidcFlowCookie,
  serializePasswordResetCookie,
  serializeSessionCookie,
  sessionCookieName,
} from "#api/modules/auth/session";
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
const acceptedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", const: "accepted" } },
} as const;
const acceptedEmailSchema = {
  ...acceptedSchema,
  required: ["status", "rateLimit"],
  properties: {
    ...acceptedSchema.properties,
    rateLimit: {
      type: "object",
      additionalProperties: false,
      required: ["limit", "remaining", "retryAfterSeconds"],
      properties: {
        limit: { type: "integer", minimum: 1 },
        remaining: { type: "integer", minimum: 0 },
        retryAfterSeconds: { type: "integer", minimum: 1 },
      },
    },
  },
} as const;
const userSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "email", "emailVerified"],
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    emailVerified: { type: "boolean" },
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
const emailPasswordBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: emailBodySchema.properties.email,
    password: passwordProperty,
  },
} as const;
const tokenBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["token"],
  properties: {
    token: { type: "string", minLength: 20, maxLength: 256 },
  },
} as const;
const passwordBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["password"],
  properties: {
    password: newPasswordProperty,
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
const setCookieHeader = {
  "Set-Cookie": {
    description: "Secure __Host-session cookie",
    type: "string",
  },
} as const;
const userWithCookieSchema = {
  ...userSchema,
  headers: setCookieHeader,
} as const;
const accountLinkRequiredSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "requiredProvider"],
  properties: {
    status: { type: "string", const: "account_link_required" },
    requiredProvider: { type: "string", enum: ["google", "password"] },
  },
  headers: {
    "Set-Cookie": {
      description: "Secure __Host-account-link cookie",
      type: "string",
    },
  },
} as const;
const passwordLoginResponseSchema = {
  oneOf: [userWithCookieSchema, accountLinkRequiredSchema],
  headers: {
    "Set-Cookie": {
      description:
        "Secure __Host-session or __Host-account-link cookie, depending on the response status",
      type: "string",
    },
  },
} as const;
const noContentWithCookieSchema = {
  type: "null",
  headers: setCookieHeader,
} as const;
const resetSessionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expiresAt"],
  properties: { expiresAt: { type: "string", format: "date-time" } },
  headers: {
    "Set-Cookie": {
      description: "Secure __Host-password-reset cookie",
      type: "string",
    },
  },
} as const;
const authorizationUrlSchema = {
  type: "object",
  additionalProperties: false,
  required: ["authorizationUrl"],
  properties: { authorizationUrl: { type: "string", format: "uri" } },
  headers: {
    "Set-Cookie": {
      description: "Secure __Host-google-oauth flow cookie",
      type: "string",
    },
  },
} as const;
const returnToProperty = { type: "string", maxLength: 2_048 } as const;
const googleStartBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { returnTo: returnToProperty },
} as const;
const googleCallbackQuerySchema = {
  type: "object",
  properties: {
    code: { type: "string", maxLength: 4_096 },
    error: { type: "string", maxLength: 128 },
    state: { type: "string", maxLength: 256 },
  },
} as const;
const redirectSchema = {
  description: "Browser redirect with an empty body",
  type: "null",
  headers: {
    Location: { type: "string", format: "uri" },
    "Set-Cookie": {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
  },
} as const;
const noContentWithClearedCookiesSchema = {
  type: "null",
  headers: {
    "Set-Cookie": {
      description: "Cleared login and password-reset cookies",
      type: "array",
      items: { type: "string" },
    },
  },
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
  const googleCodeExchange =
    options.googleCodeExchange ?? exchangeGoogleAuthorizationCode;

  server.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (
      request.method === "POST" &&
      ["/auth/login", "/auth/link/password"].includes(
        request.routeOptions.url ?? "",
      )
    ) {
      await consumePasswordLoginIp(
        options.database,
        request.clientAddress,
        options.rateLimitSecret,
      );
    }
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

  server.post<{ Body: { email: string; password: string } }>(
    "/auth/login",
    {
      schema: {
        operationId: "loginWithPassword",
        headers: originHeadersSchema,
        body: emailPasswordBodySchema,
        response: {
          200: passwordLoginResponseSchema,
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          429: rateLimitSchema,
          500: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const login = await withPasswordLoginAttempt(
        options.database,
        request.body.email,
        request.clientAddress,
        options.rateLimitSecret,
        (attempt) =>
          authenticatePassword(
            options.database,
            request.body.email,
            request.body.password,
            new Date(),
            attempt,
          ),
      );
      if (!login) return unauthorized(reply, false);
      if (login.status === "account_link_required") {
        return reply
          .header(
            "set-cookie",
            serializeAccountLinkCookie(login.linkSessionToken),
          )
          .send({
            requiredProvider: login.requiredProvider,
            status: login.status,
          });
      }
      return reply
        .header("set-cookie", serializeSessionCookie(login.sessionToken))
        .send(login.user);
    },
  );

  server.post<{ Body: { returnTo?: string } }>(
    "/auth/google/start",
    {
      schema: {
        operationId: "startGoogleLogin",
        headers: originHeadersSchema,
        body: googleStartBodySchema,
        response: {
          200: authorizationUrlSchema,
          400: errorSchema,
          403: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.googleOidc) return googleUnavailable(reply);
      const flow = await createGoogleLoginFlow(
        options.database,
        request.body.returnTo,
      );
      return reply
        .header(
          "set-cookie",
          serializeGoogleOidcFlowCookie(flow.flowToken, flow.state),
        )
        .send({
          authorizationUrl: buildGoogleAuthorizationUrl(options.googleOidc, {
            codeChallenge: flow.codeChallenge,
            nonce: flow.nonce,
            state: flow.state,
          }),
        });
    },
  );

  server.get<{
    Querystring: { code?: string; error?: string; state?: string };
  }>(
    "/auth/google/callback",
    {
      // OAuth callbacks contain one-time codes in the query string.
      logLevel: "silent",
      schema: {
        operationId: "completeGoogleAuthorization",
        querystring: googleCallbackQuerySchema,
        response: { 302: redirectSchema, 400: errorSchema },
      },
    },
    async (request, reply) => {
      const state = request.query.state;
      const flowCookie = state
        ? readCookie(request.headers.cookie, googleOidcFlowCookieName(state))
        : { invalid: true as const };
      if (
        !options.googleOidc ||
        !flowCookie.token ||
        flowCookie.invalid ||
        !state
      ) {
        return redirectGoogleError(
          reply,
          options.webOrigin,
          "/login",
          "invalid_request",
          state,
        );
      }
      const accountLink = readCookie(
        request.headers.cookie,
        accountLinkCookieName,
      );
      const flow = await consumeGoogleOidcFlow(
        options.database,
        flowCookie.token,
        state,
        accountLink.token && !accountLink.invalid
          ? accountLink.token
          : undefined,
      );
      if (!flow) {
        return redirectGoogleError(
          reply,
          options.webOrigin,
          "/login",
          "invalid_request",
          state,
        );
      }
      const errorReturnTo = flow.mode === "link" ? "/login/link" : "/login";
      if (request.query.error || !request.query.code) {
        return redirectGoogleError(
          reply,
          options.webOrigin,
          errorReturnTo,
          request.query.error === "access_denied"
            ? "provider_cancelled"
            : "provider_error",
          state,
        );
      }

      let identity: GoogleIdentity;
      try {
        identity = await googleCodeExchange(
          options.googleOidc,
          request.query.code,
          flow.codeVerifier,
          flow.nonceHash,
        );
      } catch (error) {
        server.log.warn(
          {
            authFailure: "google_provider",
            errorName: error instanceof Error ? error.name : "UnknownError",
            requestId: request.id,
          },
          "Google authorization failed",
        );
        return redirectGoogleError(
          reply,
          options.webOrigin,
          errorReturnTo,
          "provider_error",
          state,
        );
      }

      let result;
      try {
        result =
          flow.mode === "login"
            ? await completeGoogleLogin(options.database, identity)
            : await completeGoogleLink(options.database, flow, identity);
      } catch (error) {
        server.log.warn(
          {
            authFailure: "google_completion",
            errorName: error instanceof Error ? error.name : "UnknownError",
            requestId: request.id,
          },
          "Google authentication completion failed",
        );
        return redirectGoogleError(
          reply,
          options.webOrigin,
          errorReturnTo,
          "service_error",
          state,
        );
      }
      if (result.status === "account_link_required") {
        return reply
          .header("set-cookie", [
            serializeAccountLinkCookie(result.linkSessionToken),
            clearGoogleOidcFlowCookie(state),
          ])
          .redirect(new URL("/login/link", options.webOrigin).href);
      }
      if (result.status !== "authenticated") {
        return redirectGoogleError(
          reply,
          options.webOrigin,
          errorReturnTo,
          result.status,
          state,
        );
      }
      return reply
        .header("set-cookie", [
          serializeSessionCookie(result.sessionToken),
          clearAccountLinkCookie(),
          clearGoogleOidcFlowCookie(state),
        ])
        .redirect(new URL(safeReturnTo(flow.returnTo), options.webOrigin).href);
    },
  );

  server.post(
    "/auth/logout",
    {
      schema: {
        operationId: "logout",
        headers: originHeadersSchema,
        response: {
          204: noContentWithCookieSchema,
          403: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const session = readSessionCookie(request.headers.cookie);
      if (session.token) await revokeSession(options.database, session.token);
      return reply.header("set-cookie", clearSessionCookie()).code(204).send();
    },
  );

  server.get(
    "/account/me",
    {
      schema: {
        operationId: "getCurrentUser",
        security: [{ sessionCookie: [] }],
        response: { 200: userSchema, 401: errorSchema, 500: errorSchema },
      },
    },
    async (request, reply) => {
      const session = readSessionCookie(request.headers.cookie);
      if (!session.token || session.invalid) return unauthorized(reply);
      const user = await getAuthenticatedUser(options.database, session.token);
      return user ? reply.send(user) : unauthorized(reply);
    },
  );

  for (const [action, resend] of [
    ["request", false],
    ["resend", true],
  ] as const) {
    server.post<{ Body: { email: string } }>(
      `/auth/password-reset/${action}`,
      {
        schema: {
          operationId: resend
            ? "resendPasswordResetEmail"
            : "requestPasswordReset",
          headers: originHeadersSchema,
          body: emailBodySchema,
          response: {
            202: acceptedEmailSchema,
            400: errorSchema,
            403: errorSchema,
            429: rateLimitSchema,
            500: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const startedAt = performance.now();
        const rateLimit = await requestPasswordReset(
          options.database,
          request.body.email,
          request.clientAddress,
          { ...mutationOptions, resend },
        );
        await waitForAnonymousResponseFloor(startedAt);
        return reply.code(202).send({ status: "accepted", rateLimit });
      },
    );
  }

  server.post<{ Body: { token: string } }>(
    "/auth/password-reset/session",
    {
      schema: {
        operationId: "exchangePasswordResetToken",
        headers: originHeadersSchema,
        body: tokenBodySchema,
        response: {
          200: resetSessionSchema,
          400: errorSchema,
          403: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const session = await exchangePasswordResetToken(
        options.database,
        request.body.token,
      );
      if (!session) {
        return reply.code(400).send({
          code: "invalid_or_expired_token",
          message: "유효하지 않거나 만료된 재설정 링크입니다.",
        });
      }
      return reply
        .header("set-cookie", serializePasswordResetCookie(session.rawToken))
        .send({ expiresAt: session.expiresAt.toISOString() });
    },
  );

  server.post<{ Body: { password: string } }>(
    "/auth/password-reset/confirm",
    {
      schema: {
        operationId: "confirmPasswordReset",
        security: [{ passwordResetCookie: [] }],
        headers: originHeadersSchema,
        body: passwordBodySchema,
        response: {
          204: noContentWithClearedCookiesSchema,
          400: errorSchema,
          403: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const resetSession = readCookie(
        request.headers.cookie,
        passwordResetCookieName,
      );
      if (!resetSession.token || resetSession.invalid) {
        return invalidResetSession(reply);
      }
      const reset = await resetPassword(
        options.database,
        resetSession.token,
        request.body.password,
      );
      if (!reset) return invalidResetSession(reply);
      return reply
        .header("set-cookie", [
          clearSessionCookie(),
          clearPasswordResetCookie(),
        ])
        .code(204)
        .send();
    },
  );
};

const unauthorized = (reply: FastifyReply, clearCookie = true) => {
  if (clearCookie) reply.header("set-cookie", clearSessionCookie());
  return reply.code(401).send({
    code: "authentication_required",
    message: "로그인이 필요합니다.",
  });
};

const readSessionCookie = (
  header: string | undefined,
): {
  invalid: boolean;
  token?: string;
} => {
  return readCookie(header, sessionCookieName);
};

const readCookie = (
  header: string | undefined,
  name: string,
): { invalid: boolean; token?: string } => {
  if (!header) return { invalid: false };
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length !== 1) return { invalid: values.length > 1 };
  try {
    const token = decodeURIComponent(values[0]!);
    return /^[A-Za-z0-9_-]{43}$/.test(token)
      ? { invalid: false, token }
      : { invalid: true };
  } catch {
    return { invalid: true };
  }
};

const invalidResetSession = (reply: FastifyReply) => {
  return reply.header("set-cookie", clearPasswordResetCookie()).code(400).send({
    code: "invalid_or_expired_reset_session",
    message: "재설정 시간이 만료되었습니다. 새 링크를 요청해 주세요.",
  });
};

const googleUnavailable = (reply: FastifyReply) => {
  return reply.code(503).send({
    code: "provider_unavailable",
    message: "Google 로그인을 지금 사용할 수 없습니다.",
  });
};

const redirectGoogleError = (
  reply: FastifyReply,
  webOrigin: string,
  returnTo: string,
  code: string,
  state?: string,
) => {
  const destination = new URL(safeReturnTo(returnTo), webOrigin);
  destination.searchParams.set("authError", code);
  if (state) reply.header("set-cookie", clearGoogleOidcFlowCookie(state));
  return reply.redirect(destination.href);
};

const waitForAnonymousResponseFloor = async (startedAt: number) => {
  const remaining =
    anonymousResponseFloorMilliseconds - (performance.now() - startedAt);
  if (remaining > 0) await delay(remaining);
};
