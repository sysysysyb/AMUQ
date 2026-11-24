import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

// Remove each legacy path when its contract test moves in 28-4.
export const legacyProviderContractFiles = [
  "apps/backend/src/modules/auth/google.test.ts",
  "apps/backend/src/modules/email/resend.test.ts",
  "apps/backend/src/modules/email/webhook.test.ts",
];

export const testFileLineRules = [
  {
    files: [
      "{apps,packages}/*/test/**/*.{ts,tsx}",
      "tests/e2e/**/*.{js,jsx,ts,tsx,cjs,cts,mjs,mts}",
      ".github/scripts/{support,fixtures}/**/*.mjs",
    ],
    linterOptions: { noInlineConfig: true },
    rules: { "max-lines": ["error", 250] },
  },
  {
    files: [
      "{apps,packages}/**/*.test.{ts,tsx}",
      "tests/e2e/**/*.{spec,test}.{js,jsx,ts,tsx,cjs,cts,mjs,mts}",
      ".github/scripts/**/*.test.mjs",
    ],
    linterOptions: { noInlineConfig: true },
    rules: { "max-lines": ["error", 400] },
  },
  {
    files: [
      "apps/backend/test/{integration,contracts}/**/*.test.{ts,tsx}",
      ...legacyProviderContractFiles,
    ],
    rules: { "max-lines": ["error", 500] },
  },
];

export const testLineLimitExceptions = {
  // 28-2: Hold the current E2E size until the authentication flows are split.
  "tests/e2e/auth-ui.spec.ts": 2246,
  "tests/e2e/signup-ownership.spec.ts": 548,
  // 28-3: Hold the current size until the shared database tests are split by contract.
  "apps/backend/test/integration/auth-account-link.test.ts": 552,
  "apps/backend/test/integration/auth-email-rate-limit.test.ts": 582,
  "apps/backend/test/integration/auth-login-rate-limit.test.ts": 1228,
  "apps/backend/test/integration/auth-signup-challenge.test.ts": 954,
  "apps/backend/test/integration/auth-signup-completion.test.ts": 641,
  "apps/backend/test/integration/database.test.ts": 1103,
  // 28-4: Hold the current size until runtime and HTTP boundary tests are reorganized.
  "apps/backend/src/worker.test.ts": 586,
  "apps/backend/src/modules/auth/routes.test.ts": 462,
};

export const testLineLimitOverrides = (exceptions) =>
  Object.entries(exceptions).map(([filePath, maxLines]) => ({
    files: [filePath.replace(/[[\]{}()*?!+@\\]/g, "\\$&")],
    rules: { "max-lines": ["error", maxLines] },
  }));

export default defineConfig(
  {
    ignores: [
      "**/.next/**",
      "**/coverage/**",
      "**/dist/**",
      "docs/**",
      "tools/**",
    ],
  },
  {
    files: [".github/scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        fetch: "readonly",
        Response: "readonly",
        structuredClone: "readonly",
        URL: "readonly",
      },
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
    },
  },
  {
    files: [
      "apps/backend/src/**/*.ts",
      "apps/frontend/{app,components,features,lib}/**/*.{ts,tsx}",
    ],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.property.name=/^(then|catch|finally)$/]",
          message:
            "Use async/await with try/catch/finally for Promise handling.",
        },
      ],
    },
  },
  {
    files: ["apps/backend/{src,test}/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./**", "../**"],
              message:
                "Use #backend/... for source imports and #backend-test/... for test helpers.",
            },
          ],
        },
      ],
    },
  },
  ...testFileLineRules,
  ...testLineLimitOverrides(testLineLimitExceptions),
);
