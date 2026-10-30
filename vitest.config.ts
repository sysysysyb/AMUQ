import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "#api-test": fileURLToPath(new URL("./apps/api/test", import.meta.url)),
      "#api": fileURLToPath(new URL("./apps/api/src", import.meta.url)),
      "@frontend": fileURLToPath(new URL("./apps/frontend", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.{ts,tsx}"],
  },
});
