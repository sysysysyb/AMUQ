import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/coverage/**",
      "**/dist/**",
      "docs/**",
      "tools/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
