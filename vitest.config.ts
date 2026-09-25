import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#api": fileURLToPath(new URL("./apps/api/src", import.meta.url)),
      "@web": fileURLToPath(new URL("./apps/web", import.meta.url)),
    },
  },
  test: {
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.{ts,tsx}"],
  },
});
