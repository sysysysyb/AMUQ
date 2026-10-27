export const assertTestDatabaseUrl = (connectionString: string): string => {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('TEST_DATABASE_URL must target the "amuq_test" database');
  }

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    decodeURIComponent(url.pathname) !== "/amuq_test"
  ) {
    throw new Error('TEST_DATABASE_URL must target the "amuq_test" database');
  }
  return connectionString;
};
