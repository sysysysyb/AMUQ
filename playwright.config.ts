import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: {
    baseURL: "http://127.0.0.1:3000",
  },
  testDir: "./tests/e2e",
  webServer: [
    {
      command:
        "node --env-file-if-exists=.env --experimental-strip-types apps/api/src/http/index.ts",
      env: { AMUQ_ENV: "test" },
      port: 3001,
      reuseExistingServer: false,
    },
    {
      command: "corepack pnpm --filter @amuq/web exec next dev",
      port: 3000,
      reuseExistingServer: false,
    },
  ],
});
