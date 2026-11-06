import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "#backend-test": fileURLToPath(
        new URL("./apps/backend/test", import.meta.url),
      ),
      "#backend": fileURLToPath(new URL("./apps/backend/src", import.meta.url)),
      "@frontend": fileURLToPath(new URL("./apps/frontend", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.{ts,tsx}"],
  },
});
