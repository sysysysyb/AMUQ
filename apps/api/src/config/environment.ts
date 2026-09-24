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
