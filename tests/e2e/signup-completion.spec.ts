import { expect, test } from "@playwright/test";

import {
  at,
  epoch,
  installSignupOwnershipMocks,
  token,
  verify,
} from "./support/signup-ownership";

test.describe.configure({ mode: "parallel" });

test.beforeEach(async ({ page }) => {
  await installSignupOwnershipMocks(page);
});

test("only sends a password after email ownership and completes signup", async ({
  page,
}) => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/auth/signup"))
      requests.push({
        path: new URL(request.url()).pathname,
        body: request.postDataJSON(),
      });
  });
  await page.route("**/api/auth/signup/complete", (route) =>
    route.fulfill({ json: { status: "created" } }),
  );
  await page.goto("/signup");
  await expect(page.getByLabel("비밀번호", { exact: true })).toBeDisabled();
  await verify(page);
  await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
  await page.getByLabel("비밀번호 확인", { exact: true }).fill("ValidPass1234");
  await page.getByRole("button", { name: "회원가입", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "회원가입이 완료되었습니다!" }),
  ).toBeVisible();
  expect(
    requests
      .filter((request) => request.path !== "/api/auth/signup/complete")
      .every((request) => !("password" in request.body)),
  ).toBe(true);
  expect(
    requests.find((request) => request.path.endsWith("/complete"))?.body,
  ).toEqual({ signupProof: "b".repeat(64), password: "ValidPass1234" });
});

test("retains this tab's password on expiry and completes after re-verification", async ({
  page,
}) => {
  await page.route("**/api/auth/signup/challenges/resend", (route) =>
    route.fulfill({
      status: 202,
      json: {
        status: "accepted",
        attemptToken: token,
        codeExpiresAt: at(2_500),
        resendAvailableAt: at(1_960),
      },
    }),
  );
  await page.route("**/api/auth/signup/complete", (route) =>
    route.fulfill({ json: { status: "created" } }),
  );
  await verify(page);
  await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
  await page.getByLabel("비밀번호 확인", { exact: true }).fill("ValidPass1234");
  await page.clock.fastForward(1_801_000);
  await expect(
    page.getByText(
      "인증이 만료됐어요. 입력한 비밀번호는 유지되며 이메일을 다시 인증해 주세요.",
    ),
  ).toBeVisible();
  await expect
    .soft(page.getByRole("status"))
    .toContainText("인증이 만료됐어요.");
  await expect
    .soft(page.getByRole("button", { name: "재전송", exact: true }))
    .toBeFocused();
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue(
    "ValidPass1234",
  );
  await expect(
    page.getByRole("button", { name: "회원가입", exact: true }),
  ).toBeDisabled();
  await page.route("**/api/auth/signup/challenges/verify", (route) =>
    route.fulfill({
      json: {
        status: "verified",
        signupProof: "c".repeat(64),
        proofExpiresAt: at(3_600),
      },
    }),
  );
  await page.getByRole("button", { name: "재전송", exact: true }).click();
  await expect(page.getByLabel("인증번호", { exact: true })).toBeFocused();
  await page.getByLabel("인증번호", { exact: true }).fill("654321");
  await page.getByRole("button", { name: "인증 확인", exact: true }).click();
  await expect(page.getByLabel("비밀번호 확인", { exact: true })).toHaveValue(
    "ValidPass1234",
  );
  await page.getByRole("button", { name: "회원가입", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "회원가입이 완료되었습니다!" }),
  ).toBeVisible();
});

test("never restores signup credentials after refreshing", async ({ page }) => {
  await verify(page);
  await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
  await page.reload();
  await expect(page.getByLabel("이메일", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("비밀번호", { exact: true })).toBeDisabled();
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
});

test("focuses the expiry notice when the server still blocks resending", async ({
  page,
}) => {
  await page.route("**/api/auth/signup/challenges", (route) =>
    route.fulfill({
      status: 202,
      json: {
        status: "accepted",
        attemptToken: token,
        codeExpiresAt: at(600),
        resendAvailableAt: at(3_600),
      },
    }),
  );
  await verify(page);
  await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
  await page.clock.fastForward(1_801_000);
  const notice = page.getByRole("status");
  await expect(notice).toContainText("인증이 만료됐어요.");
  await expect(notice).toBeFocused();
  await expect(
    page.getByRole("button", { name: "재전송", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("비밀번호", { exact: true })).toHaveValue(
    "ValidPass1234",
  );
});

test("uses server time when the device clock is two hours ahead", async ({
  page,
}) => {
  await page.clock.setSystemTime(new Date(epoch + 7_200_000));
  await page.route("**/api/auth/signup/challenges", (route) =>
    route.fulfill({
      status: 202,
      headers: { date: new Date(epoch).toUTCString() },
      json: {
        status: "accepted",
        attemptToken: token,
        codeExpiresAt: at(600),
        resendAvailableAt: at(60),
      },
    }),
  );
  await page.route("**/api/auth/signup/challenges/verify", (route) =>
    route.fulfill({
      headers: { date: new Date(epoch).toUTCString() },
      json: {
        status: "verified",
        signupProof: "b".repeat(64),
        proofExpiresAt: at(1_800),
      },
    }),
  );
  await verify(page);
  await expect(page.getByLabel("비밀번호", { exact: true })).toBeEnabled();
  await page.clock.fastForward(1_801_000);
  await expect(
    page.getByRole("button", { name: "회원가입", exact: true }),
  ).toBeDisabled();
});

test("blocks completion retries until the server cooldown ends", async ({
  page,
}) => {
  await page.route("**/api/auth/signup/complete", (route) =>
    route.fulfill({
      status: 429,
      headers: { "retry-after": "60" },
      json: { code: "rate_limit_exceeded" },
    }),
  );
  await verify(page);
  await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
  await page.getByLabel("비밀번호 확인", { exact: true }).fill("ValidPass1234");
  const submit = page.getByRole("button", { name: "회원가입", exact: true });
  await submit.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "이후 다시 요청",
  );
  await expect(submit).toBeDisabled();
  await page.clock.fastForward(60_000);
  await expect(submit).toBeEnabled();
});

test("allows completion with a valid code despite the resend cooldown", async ({
  page,
}) => {
  await page.route("**/api/auth/signup/challenges/resend", (route) =>
    route.fulfill({
      status: 429,
      headers: { "retry-after": "3600" },
      json: { code: "rate_limit_exceeded" },
    }),
  );
  await page.route("**/api/auth/signup/complete", (route) =>
    route.fulfill({ json: { status: "created" } }),
  );
  await page.goto("/signup");
  await page.getByLabel("이메일", { exact: true }).fill("qa@example.com");
  await page.getByRole("button", { name: "인증 요청", exact: true }).click();
  await page.clock.fastForward(60_000);
  await page.getByRole("button", { name: "재전송", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "이후 다시 요청",
  );
  await page.getByLabel("인증번호", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "인증 확인", exact: true }).click();
  await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
  await page.getByLabel("비밀번호 확인", { exact: true }).fill("ValidPass1234");
  await expect(
    page.getByRole("button", { name: "회원가입", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "회원가입", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "회원가입이 완료되었습니다!" }),
  ).toBeVisible();
});

test("allows re-verification after proof expiry despite a completion cooldown", async ({
  page,
}) => {
  await page.route("**/api/auth/signup/complete", (route) =>
    route.fulfill({
      status: 429,
      headers: { "retry-after": "3600" },
      json: { code: "rate_limit_exceeded" },
    }),
  );
  await verify(page);
  await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
  await page.getByLabel("비밀번호 확인", { exact: true }).fill("ValidPass1234");
  await page.getByRole("button", { name: "회원가입", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "이후 다시 요청",
  );
  await page.clock.fastForward(1_801_000);
  await expect(
    page.getByRole("button", { name: "재전송", exact: true }),
  ).toBeEnabled();
});
