export type ApplicationEnvironment = "development" | "production" | "test";

export function applicationEnvironment(
  environment: Record<string, string | undefined> = process.env,
): ApplicationEnvironment {
  const value = environment.AMUQ_ENV;
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }
  throw new Error("AMUQ_ENV must be development, test, or production");
}

export function proxySharedSecret(
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  const application = applicationEnvironment(environment);
  const secret = environment.PROXY_SHARED_SECRET;

  if (!secret) {
    if (application === "production") {
      throw new Error("PROXY_SHARED_SECRET is required in production");
    }
    return undefined;
  }
  return secret;
}
