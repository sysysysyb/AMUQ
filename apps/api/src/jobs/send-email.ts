import { createHash } from "node:crypto";

import { applicationEnvironment } from "#api/config/environment";
import { deriveSignupCode } from "#api/modules/auth/signup-token";
import {
  type AuthTokenPurpose,
  authTokenSecretFor,
  deriveAuthToken,
} from "#api/modules/auth/token";
import {
  type ResendEmail,
  ResendEmailError,
  type ResendEmailResult,
  resendRequestTimeoutMs,
} from "#api/modules/email/resend";

export const sendEmailQueue = "send-email";

const idempotencyWindowMs = 24 * 60 * 60 * 1_000;
const deliveryBatchSize = 25;
const retryEligibleSql = `(outbox.attempt_count = 0
  OR outbox.updated_at <= $1::timestamptz - interval '1 minute' * LEAST(
    60::double precision,
    power(2::double precision, GREATEST(outbox.attempt_count - 1, 0))
  ))`;

interface EmailDatabase {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface PendingEmail {
  claimedAt: Date;
  createdAt: Date;
  email: string;
  expiresAt: Date;
  outboxId: string;
  payloadHash: string | null;
  purpose: AuthTokenPurpose | "signup_code";
  tokenId: string;
  tokenKeyId: string | null;
}

interface DeliveryOptions {
  authTokenPreviousSecret?: string;
  authTokenSecret: string;
  clock?: () => Date;
  from: string;
  sendEmail(email: ResendEmail): Promise<ResendEmailResult>;
  webOrigin: string;
}

export interface EmailDeliveryConfig {
  apiKey: string;
  authTokenPreviousSecret?: string;
  authTokenSecret: string;
  from: string;
  webOrigin: string;
}

export const emailDeliveryConfig = (
  environment: Record<string, string | undefined> = process.env,
): EmailDeliveryConfig => {
  const application = applicationEnvironment(environment);
  const authTokenSecret = required(environment, "AUTH_TOKEN_SECRET");
  if (Buffer.byteLength(authTokenSecret, "utf8") < 32) {
    throw new Error("AUTH_TOKEN_SECRET must be at least 32 bytes");
  }
  const authTokenPreviousSecret =
    environment.AUTH_TOKEN_PREVIOUS_SECRET || undefined;
  if (
    authTokenPreviousSecret &&
    Buffer.byteLength(authTokenPreviousSecret, "utf8") < 32
  ) {
    throw new Error("AUTH_TOKEN_PREVIOUS_SECRET must be at least 32 bytes");
  }

  const webOrigin = new URL(required(environment, "WEB_ORIGIN"));
  if (application === "production" && webOrigin.protocol !== "https:") {
    throw new Error("WEB_ORIGIN must use HTTPS in production");
  }
  if (
    !["http:", "https:"].includes(webOrigin.protocol) ||
    webOrigin.username ||
    webOrigin.password ||
    webOrigin.pathname !== "/" ||
    webOrigin.search ||
    webOrigin.hash
  ) {
    throw new Error(
      "WEB_ORIGIN must be an HTTP origin without credentials or a path",
    );
  }

  return {
    apiKey: required(environment, "RESEND_API_KEY"),
    ...(authTokenPreviousSecret ? { authTokenPreviousSecret } : {}),
    authTokenSecret,
    from: required(environment, "RESEND_FROM_EMAIL"),
    webOrigin: webOrigin.origin,
  };
};

export const deliverPendingEmails = async (
  database: EmailDatabase,
  options: DeliveryOptions,
): Promise<{ failed: number; retrying: number; sent: number }> => {
  const result = { failed: 0, retrying: 0, sent: 0 };
  const currentTime = options.clock ?? (() => new Date());
  const retired = await database.executeSql(
    `WITH consumed AS (
       SELECT outbox.id
         FROM email_outbox AS outbox
         LEFT JOIN auth_tokens AS token ON token.id = outbox.token_id
         LEFT JOIN auth_signup_codes AS code ON code.id = outbox.signup_code_id
        WHERE (token.consumed_at IS NOT NULL OR code.revoked_at IS NOT NULL OR code.verified_at IS NOT NULL)
          AND outbox.status = 'pending'
          AND ${retryEligibleSql}
        ORDER BY outbox.created_at, outbox.id
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT ${deliveryBatchSize}
     )
     UPDATE email_outbox AS outbox
        SET status = 'failed',
            last_error_code = 'token_consumed',
            updated_at = $1
       FROM consumed
      WHERE outbox.id = consumed.id
    RETURNING outbox.id`,
    [currentTime()],
  );
  result.failed += retired.rows.length;

  for (let processed = 0; processed < deliveryBatchSize; processed += 1) {
    const email = await nextPendingEmail(database, currentTime());
    if (!email) break;

    const authTokenSecret = authTokenSecretFor(email.tokenKeyId, options);
    if (!authTokenSecret) {
      const checkedAt = currentTime();
      const deadlineError = deliveryDeadlineError(email, checkedAt);
      if (deadlineError) {
        if (
          await markUndeliverable(
            database,
            email.outboxId,
            deadlineError,
            checkedAt,
            email.claimedAt,
          )
        ) {
          result.failed += 1;
        }
        continue;
      }
      const retryable = email.tokenKeyId !== null;
      const updated = retryable
        ? await recordFailure(
            database,
            email.outboxId,
            "auth_token_key_unavailable",
            currentTime(),
            true,
            email.claimedAt,
          )
        : await markUndeliverable(
            database,
            email.outboxId,
            "auth_token_key_unavailable",
            currentTime(),
            email.claimedAt,
          );
      if (updated) {
        result[retryable ? "retrying" : "failed"] += 1;
      }
      continue;
    }

    const renderedEmail = renderEmail(
      email,
      authTokenSecret,
      options.from,
      options.webOrigin,
    );
    const fingerprint = await preservePayloadFingerprint(
      database,
      email,
      renderedEmail,
    );
    if (fingerprint === "stale") continue;
    if (fingerprint === "changed") {
      if (
        await markUndeliverable(
          database,
          email.outboxId,
          "email_payload_changed",
          currentTime(),
          email.claimedAt,
        )
      ) {
        result.failed += 1;
      }
      continue;
    }

    const sendStartedAt = currentTime();
    if (
      !(await renewClaim(
        database,
        email.outboxId,
        email.claimedAt,
        sendStartedAt,
      ))
    ) {
      continue;
    }
    const now = currentTime();
    const deadlineError = deliveryDeadlineError(email, now);
    if (deadlineError) {
      if (
        await markUndeliverable(
          database,
          email.outboxId,
          deadlineError,
          now,
          sendStartedAt,
        )
      ) {
        result.failed += 1;
      }
      continue;
    }

    try {
      const provider = await options.sendEmail(renderedEmail);
      const completedAt = currentTime();
      const updated = await database.executeSql(
        `UPDATE email_outbox
            SET status = 'sent',
                provider_message_id = $2,
                last_error_code = NULL,
                updated_at = $3,
                sent_at = $3
          WHERE id = $1
            AND status = 'pending'
            AND updated_at = $4
        RETURNING id`,
        [
          email.outboxId,
          provider.providerMessageId,
          completedAt,
          sendStartedAt,
        ],
      );
      if (updated.rows[0]) result.sent += 1;
    } catch (error) {
      const deliveryError =
        error instanceof ResendEmailError
          ? error
          : new ResendEmailError("resend_unknown", true);
      const updated = await recordFailure(
        database,
        email.outboxId,
        deliveryError.code,
        currentTime(),
        deliveryError.retryable,
        sendStartedAt,
      );
      if (updated) {
        result[deliveryError.retryable ? "retrying" : "failed"] += 1;
      }
    }
  }

  return result;
};

const deliveryDeadlineError = (
  email: Pick<PendingEmail, "createdAt" | "expiresAt">,
  now: Date,
): "idempotency_expired" | "token_expired" | undefined => {
  const safeDeadline = now.getTime() + resendRequestTimeoutMs;
  if (email.expiresAt.getTime() <= safeDeadline) return "token_expired";
  if (email.createdAt.getTime() + idempotencyWindowMs <= safeDeadline) {
    return "idempotency_expired";
  }
  return undefined;
};

const markUndeliverable = async (
  database: EmailDatabase,
  outboxId: string,
  code: string,
  now: Date,
  claimedAt: Date,
): Promise<boolean> => {
  const result = await database.executeSql(
    `UPDATE email_outbox
        SET status = 'failed',
            attempt_count = GREATEST(attempt_count - 1, 0),
            last_error_code = $2,
            updated_at = $3
      WHERE id = $1
        AND status = 'pending'
        AND updated_at = $4
    RETURNING id`,
    [outboxId, code, now, claimedAt],
  );
  return Boolean(result.rows[0]);
};

const nextPendingEmail = async (
  database: EmailDatabase,
  now: Date,
): Promise<PendingEmail | undefined> => {
  const result = await database.executeSql(
    `WITH candidate AS (
       SELECT outbox.id,
              coalesce(token.id, code.id) AS token_id,
              CASE WHEN code.id IS NOT NULL THEN 'signup_code' ELSE token.purpose::text END AS purpose,
              coalesce(token.expires_at, code.expires_at) AS expires_at,
              coalesce(code.recipient, users.email) AS email
         FROM email_outbox AS outbox
         LEFT JOIN auth_tokens AS token ON token.id = outbox.token_id
         LEFT JOIN users ON users.id = token.user_id
         LEFT JOIN auth_signup_codes AS code ON code.id = outbox.signup_code_id
        WHERE outbox.status = 'pending'
          AND token.consumed_at IS NULL
          AND code.revoked_at IS NULL
          AND code.verified_at IS NULL
          AND ${retryEligibleSql}
        ORDER BY outbox.created_at, outbox.id
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT 1
     ), claimed AS (
       UPDATE email_outbox AS outbox
          SET attempt_count = outbox.attempt_count + 1,
              updated_at = $1
         FROM candidate
        WHERE outbox.id = candidate.id
       RETURNING outbox.id::text AS "outboxId",
                 outbox.updated_at AS "claimedAt",
                 outbox.created_at AS "createdAt",
                 outbox.payload_hash AS "payloadHash",
                 outbox.token_key_id AS "tokenKeyId",
                 candidate.token_id::text AS "tokenId",
                 candidate.purpose,
                 candidate.expires_at AS "expiresAt",
                 candidate.email
     )
     SELECT * FROM claimed`,
    [now],
  );
  return result.rows[0] as PendingEmail | undefined;
};

const recordFailure = async (
  database: EmailDatabase,
  outboxId: string,
  code: string,
  now: Date,
  retryable: boolean,
  claimedAt: Date,
): Promise<boolean> => {
  const result = await database.executeSql(
    `UPDATE email_outbox
        SET status = CASE
              WHEN $4 THEN 'pending'::email_delivery_status
              ELSE 'failed'::email_delivery_status
            END,
            last_error_code = $2,
            updated_at = $3
      WHERE id = $1
        AND status = 'pending'
        AND updated_at = $5
    RETURNING id`,
    [outboxId, code, now, retryable, claimedAt],
  );
  return Boolean(result.rows[0]);
};

const preservePayloadFingerprint = async (
  database: EmailDatabase,
  pending: PendingEmail,
  email: ResendEmail,
): Promise<"changed" | "ok" | "stale"> => {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(email), "utf8")
    .digest("hex");
  if (pending.payloadHash) {
    return pending.payloadHash === payloadHash ? "ok" : "changed";
  }

  const result = await database.executeSql(
    `UPDATE email_outbox
        SET payload_hash = $2
      WHERE id = $1
        AND status = 'pending'
        AND payload_hash IS NULL
        AND updated_at = $3
    RETURNING id`,
    [pending.outboxId, payloadHash, pending.claimedAt],
  );
  return result.rows[0] ? "ok" : "stale";
};

const renewClaim = async (
  database: EmailDatabase,
  outboxId: string,
  claimedAt: Date,
  renewedAt: Date,
): Promise<boolean> => {
  const result = await database.executeSql(
    `UPDATE email_outbox
        SET updated_at = $3
      WHERE id = $1
        AND status = 'pending'
        AND updated_at = $2
        AND EXISTS (
          SELECT 1
            FROM auth_tokens
           WHERE auth_tokens.id = email_outbox.token_id
             AND auth_tokens.consumed_at IS NULL
          UNION ALL
          SELECT 1 FROM auth_signup_codes code
           WHERE code.id = email_outbox.signup_code_id
             AND code.revoked_at IS NULL AND code.verified_at IS NULL
        )
    RETURNING id`,
    [outboxId, claimedAt, renewedAt],
  );
  return Boolean(result.rows[0]);
};

const renderEmail = (
  email: PendingEmail,
  authTokenSecret: string,
  from: string,
  webOrigin: string,
): ResendEmail => {
  if (email.purpose === "signup_code") {
    const code = deriveSignupCode(email.tokenId, authTokenSecret);
    return {
      from,
      html: `<p>AMUQ 가입 인증번호입니다.</p><p><strong>${code}</strong></p><p>10분 안에 가입 화면에 입력하세요. 요청하지 않았다면 이 메일을 무시하세요.</p>`,
      idempotencyKey: `auth-email/${email.outboxId}`,
      subject: "AMUQ 가입 인증번호",
      text: `AMUQ 가입 인증번호: ${code}\n\n10분 안에 가입 화면에 입력하세요. 요청하지 않았다면 이 메일을 무시하세요.`,
      to: email.email,
    };
  }
  const rawToken = deriveAuthToken(
    email.purpose,
    email.tokenId,
    authTokenSecret,
  );
  const link = new URL(
    email.purpose === "email_verification"
      ? "/verify-email"
      : "/reset-password",
    webOrigin,
  );
  link.searchParams.set("token", rawToken);

  const verification = email.purpose === "email_verification";
  const action = verification ? "이메일 인증" : "비밀번호 재설정";
  const lifetime = verification ? "24시간" : "30분";
  const text = `${action}을 완료하려면 아래 링크를 이용하세요.\n\n${link.href}\n\n이 링크는 ${lifetime} 동안 한 번만 사용할 수 있습니다.`;

  return {
    from,
    html: `<p>${action}을 완료하려면 아래 링크를 이용하세요.</p><p><a href="${link.href}">${action}</a></p><p>이 링크는 ${lifetime} 동안 한 번만 사용할 수 있습니다.</p>`,
    idempotencyKey: `auth-email/${email.outboxId}`,
    subject: `AMUQ ${action}`,
    text,
    to: email.email,
  };
};

const required = (
  environment: Record<string, string | undefined>,
  name: string,
): string => {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
