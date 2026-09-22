import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: {
    baseURL: "http://127.0.0.1:3000",
  },
  testDir: "./tests/e2e",
  webServer: [
    {
      command:
        "corepack pnpm --filter @amuq/api exec node --experimental-strip-types src/http/index.ts",
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
