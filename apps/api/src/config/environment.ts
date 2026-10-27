export type ApplicationEnvironment = "development" | "production" | "test";

export const resendWebhookSecret = (
  environment: Record<string, string | undefined> = process.env,
): string | undefined => {
  const application = applicationEnvironment(environment);
  const secret = environment.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    if (application === "production") {
      throw new Error("RESEND_WEBHOOK_SECRET is required in production");
    }
    return undefined;
  }
  const encoded = secret.slice("whsec_".length);
  const decoded = Buffer.from(encoded, "base64");
  if (
    !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) ||
    decoded.length < 16 ||
    decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw new Error(
      "RESEND_WEBHOOK_SECRET must be a valid whsec_ signing secret",
    );
  }
  return secret;
};

export const applicationEnvironment = (
  environment: Record<string, string | undefined> = process.env,
): ApplicationEnvironment => {
  const value = environment.AMUQ_ENV;
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }
  throw new Error("AMUQ_ENV must be development, test, or production");
};

export const proxySharedSecret = (
  environment: Record<string, string | undefined> = process.env,
): string | undefined => {
  const application = applicationEnvironment(environment);
  const secret = environment.PROXY_SHARED_SECRET;

  if (!secret) {
    if (application === "production") {
      throw new Error("PROXY_SHARED_SECRET is required in production");
    }
    return undefined;
  }
  return secret;
};

export interface AuthApiConfig {
  allowedOrigins: string[];
  authTokenSecret: string;
  authTokenPreviousSecret?: string;
  rateLimitSecret: string;
  webOrigin: string;
}

export interface GoogleOidcConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const googleOidcConfig = (
  environment: Record<string, string | undefined> = process.env,
): GoogleOidcConfig | undefined => {
  const application = applicationEnvironment(environment);
  const clientId = environment.GOOGLE_OIDC_CLIENT_ID;
  const clientSecret = environment.GOOGLE_OIDC_CLIENT_SECRET;
  const redirectUri = environment.GOOGLE_OIDC_REDIRECT_URI;

  if (!clientId && !clientSecret && !redirectUri) {
    if (application === "production") {
      throw new Error("Google OIDC configuration is required in production");
    }
    return undefined;
  }
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OIDC configuration must include all three values");
  }

  const redirectUrl = new URL(redirectUri);
  if (
    !["http:", "https:"].includes(redirectUrl.protocol) ||
    redirectUrl.username ||
    redirectUrl.password ||
    !["/auth/google/callback", "/api/auth/google/callback"].includes(
      redirectUrl.pathname,
    ) ||
    redirectUrl.search ||
    redirectUrl.hash
  ) {
    throw new Error("GOOGLE_OIDC_REDIRECT_URI must be a safe HTTP URL");
  }
  if (application === "production" && redirectUrl.protocol !== "https:") {
    throw new Error("GOOGLE_OIDC_REDIRECT_URI must use HTTPS in production");
  }
  if (application === "production") {
    const webOrigin = parseOrigin(environment, "WEB_ORIGIN", application);
    if (
      redirectUrl.origin !== webOrigin ||
      redirectUrl.pathname !== "/api/auth/google/callback"
    ) {
      throw new Error(
        "GOOGLE_OIDC_REDIRECT_URI must use the WEB_ORIGIN /api proxy in production",
      );
    }
  }

  return { clientId, clientSecret, redirectUri: redirectUrl.href };
};

export const authApiConfig = (
  environment: Record<string, string | undefined> = process.env,
): AuthApiConfig => {
  const application = applicationEnvironment(environment);
  const authTokenSecret = requiredSecret(environment, "AUTH_TOKEN_SECRET");
  const authTokenPreviousSecret = environment.AUTH_TOKEN_PREVIOUS_SECRET
    ? requiredSecret(environment, "AUTH_TOKEN_PREVIOUS_SECRET")
    : undefined;
  const rateLimitSecret = requiredSecret(environment, "AUTH_RATE_LIMIT_SECRET");
  const webOrigin = parseOrigin(environment, "WEB_ORIGIN", application);
  const apiOrigin = environment.API_ORIGIN;
  if (apiOrigin && application !== "development") {
    throw new Error("API_ORIGIN is allowed only in development");
  }

  return {
    allowedOrigins: [
      webOrigin,
      ...(apiOrigin
        ? [parseOrigin(environment, "API_ORIGIN", application)]
        : []),
    ],
    authTokenSecret,
    ...(authTokenPreviousSecret ? { authTokenPreviousSecret } : {}),
    rateLimitSecret,
    webOrigin,
  };
};

const requiredSecret = (
  environment: Record<string, string | undefined>,
  name: string,
): string => {
  const secret = environment[name];
  if (!secret) throw new Error(`${name} is required`);
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(`${name} must be at least 32 bytes`);
  }
  return secret;
};

const parseOrigin = (
  environment: Record<string, string | undefined>,
  name: "API_ORIGIN" | "WEB_ORIGIN",
  application: ApplicationEnvironment,
): string => {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  const origin = new URL(value);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      `${name} must be an HTTP origin without credentials or a path`,
    );
  }
  if (application === "production" && origin.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  return origin.origin;
};
