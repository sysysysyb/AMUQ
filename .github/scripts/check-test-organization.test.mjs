import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

import {
  legacyProviderContractFiles,
  testFileLineRules,
  testLineLimitExceptions,
  testLineLimitOverrides,
} from "../../eslint.config.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });
const eslintWithoutExceptions = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  overrideConfig: testFileLineRules,
});

const lintLines = async (filePath, lines) => {
  const [result] = await eslint.lintText("// fixture\n".repeat(lines), {
    filePath,
  });
  return result.messages;
};

test("enforces the 400-line boundary for browser and unit tests", async () => {
  for (const filePath of [
    "tests/e2e/login.spec.ts",
    "apps/frontend/components/ui/field.test.tsx",
    "apps/backend/test/support/test-database.test.ts",
    "packages/contracts/src/auth.test.ts",
    ".github/scripts/check-test-organization.test.mjs",
  ]) {
    assert.deepEqual(await lintLines(filePath, 400), [], filePath);
    const messages = await lintLines(filePath, 401);
    assert.deepEqual(
      messages.map(({ ruleId }) => ruleId),
      ["max-lines"],
      filePath,
    );
    assert.match(messages[0].message, /401.*400/);
  }
});

test("allows up to 500 lines for integration and provider contract tests", async () => {
  for (const filePath of legacyProviderContractFiles) {
    await access(resolve(repoRoot, filePath));
  }
  for (const filePath of [
    "apps/backend/test/integration/auth-session.test.ts",
    "apps/backend/test/contracts/example.test.ts",
    ...legacyProviderContractFiles,
  ]) {
    assert.deepEqual(await lintLines(filePath, 500), [], filePath);
    const messages = await lintLines(filePath, 501);
    assert.deepEqual(
      messages.map(({ ruleId }) => ruleId),
      ["max-lines"],
      filePath,
    );
    assert.match(messages[0].message, /501.*500/);
  }
});

test("counts blank lines and comments in shared test support", async () => {
  for (const filePath of [
    "apps/backend/test/support/auth-database.ts",
    "apps/backend/test/helpers.ts",
    "apps/frontend/test/render-helpers.tsx",
    "tests/e2e/fixtures/session.ts",
    "tests/e2e/helpers.ts",
    "packages/contracts/test/helpers.ts",
  ]) {
    assert.deepEqual(await lintLines(filePath, 250), [], filePath);
    const [result] = await eslint.lintText("\n".repeat(250) + "// fixture\n", {
      filePath,
    });
    const [message] = result.messages;
    assert.equal(message?.ruleId, "max-lines", filePath);
    assert.match(message.message, /251.*250/);
  }
  assert.deepEqual(await lintLines("apps/frontend/app/test/page.tsx", 251), []);
});

test("caps every existing exception at the current file size", async () => {
  for (const [filePath, maxLines] of Object.entries(testLineLimitExceptions)) {
    const baseConfig =
      await eslintWithoutExceptions.calculateConfigForFile(filePath);
    const baseLimit = baseConfig?.rules?.["max-lines"]?.[1];
    assert.ok(
      Number.isInteger(baseLimit),
      `${filePath} has no base line limit`,
    );
    assert.ok(maxLines > baseLimit, `${filePath} no longer needs an exception`);
    const source = await readFile(resolve(repoRoot, filePath), "utf8");
    const [current] = await eslint.lintText(source, { filePath });
    assert.ok(
      !current.messages.some(({ ruleId }) => ruleId === "max-lines"),
      filePath,
    );

    const withExtraLine = source.endsWith("\n")
      ? `${source}\n`
      : `${source}\n\n`;
    const [extended] = await eslint.lintText(withExtraLine, { filePath });
    const message = extended.messages.find(
      ({ ruleId }) => ruleId === "max-lines",
    );
    assert.match(
      message?.message ?? "",
      new RegExp(`${maxLines + 1}.*${maxLines}`),
      `${filePath} must have an exception matching its current size`,
    );
  }
});

test("applies an exception to a literal bracket path only", async () => {
  const filePath = "apps/frontend/app/api/[id]/route.test.ts";
  const eslintWithException = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      ...testFileLineRules,
      ...testLineLimitOverrides({ [filePath]: 401 }),
    ],
  });

  const exact = await eslintWithException.calculateConfigForFile(filePath);
  assert.equal(exact?.rules?.["max-lines"]?.[1], 401);

  for (const nearbyPath of [
    "apps/frontend/app/api/i/route.test.ts",
    "apps/frontend/app/api/[id]/route-copy.test.ts",
  ]) {
    const nearby = await eslintWithException.calculateConfigForFile(nearbyPath);
    assert.equal(nearby?.rules?.["max-lines"]?.[1], 400, nearbyPath);
  }
});

test("keeps a file-level disable comment from bypassing the limit", async () => {
  for (const [filePath, limit] of [
    ["tests/e2e/login.spec.ts", 400],
    ["tests/e2e/helpers.ts", 250],
    ["apps/backend/test/integration/auth-session.test.ts", 500],
    ...Object.entries(testLineLimitExceptions),
  ]) {
    const [result] = await eslint.lintText(
      "/* eslint-disable max-lines */\n" + "\n".repeat(limit),
      { filePath },
    );
    assert.ok(
      result.messages.some(({ ruleId }) => ruleId === "max-lines"),
      filePath,
    );
  }
});
