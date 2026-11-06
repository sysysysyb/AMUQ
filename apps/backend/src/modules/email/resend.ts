export interface ResendEmail {
  from: string;
  html: string;
  idempotencyKey: string;
  subject: string;
  text: string;
  to: string;
}

export interface ResendEmailResult {
  providerMessageId: string;
}

export const resendRequestTimeoutMs = 10_000;

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class ResendEmailError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "ResendEmailError";
    this.code = code;
    this.retryable = retryable;
  }
}

export const sendResendEmail = async (
  email: ResendEmail,
  options: { apiKey: string; fetcher?: Fetcher },
): Promise<ResendEmailResult> => {
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(
      "https://api.resend.com/emails",
      {
        body: JSON.stringify({
          from: email.from,
          html: email.html,
          subject: email.subject,
          text: email.text,
          to: [email.to],
        }),
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
        },
        method: "POST",
        signal: AbortSignal.timeout(resendRequestTimeoutMs),
      },
    );
  } catch {
    throw new ResendEmailError("resend_network", true);
  }

  if (!response.ok) {
    const conflict =
      response.status === 409 ? await resendConflict(response) : undefined;
    throw new ResendEmailError(
      conflict ? `resend_${conflict}` : `resend_${response.status}`,
      conflict === "concurrent_idempotent_requests" ||
        response.status === 429 ||
        response.status >= 500,
    );
  }

  const body: unknown = await response.json();
  if (!hasMessageId(body)) {
    throw new ResendEmailError("resend_invalid_response", true);
  }
  return { providerMessageId: body.id };
};

const resendConflict = async (
  response: Response,
): Promise<
  "concurrent_idempotent_requests" | "invalid_idempotent_request" | undefined
> => {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "name" in body &&
      (body.name === "concurrent_idempotent_requests" ||
        body.name === "invalid_idempotent_request")
    ) {
      return body.name;
    }
  } catch {
    // The status code remains sufficient when the provider body is malformed.
  }
  return undefined;
};

const hasMessageId = (value: unknown): value is { id: string } => {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
};
