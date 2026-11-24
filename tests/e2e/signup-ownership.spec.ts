import { expect, test } from "@playwright/test";

import {
  at,
  installSignupOwnershipMocks,
  token,
  verify,
} from "./support/signup-ownership";

test.describe.configure({ mode: "parallel" });

test.beforeEach(async ({ page }) => {
  await installSignupOwnershipMocks(page);
});

test("displays wrong-code attempts and the server's resend retry time", async ({
  page,
}) => {
  await page.route("**/api/auth/signup/challenges/verify", (route) =>
    route.fulfill({
      status: 400,
      json: { status: "invalid_code", remainingAttempts: 4 },
    }),
  );
  await verify(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("4회");
  await page.clock.fastForward(60_000);
  await page.route("**/api/auth/signup/challenges/resend", (route) =>
    route.fulfill({
      status: 429,
      headers: { "retry-after": "3600" },
      json: { code: "rate_limit_exceeded" },
    }),
  );
  await page.getByRole("button", { name: "재전송", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "다시 요청",
  );
  await expect(
    page.getByRole("button", { name: "재전송", exact: true }),
  ).toBeDisabled();
});

test("old links only guide to a new signup and never exchange a token", async ({
  page,
}) => {
  let exchanged = false;
  await page.route("**/api/auth/verify-email", (route) => {
    exchanged = true;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/verify-email?token=" + token);
  await expect(
    page.getByRole("link", { name: "이메일 인증 다시 시작" }),
  ).toHaveAttribute("href", "/signup");
  expect(exchanged).toBe(false);
});

test("keeps resend blocked for the complete server-provided hour", async ({
  page,
}) => {
  await page.route("**/api/auth/signup/challenges/resend", (route) =>
    route.fulfill({
      status: 429,
      headers: { "retry-after": "3600" },
      json: { code: "rate_limit_exceeded" },
    }),
  );
  await page.goto("/signup");
  await page.getByLabel("이메일", { exact: true }).fill("qa@example.com");
  await page.getByRole("button", { name: "인증 요청", exact: true }).click();
  await page.clock.fastForward(60_000);
  const resend = page.getByRole("button", { name: "재전송", exact: true });
  await resend.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "이후 다시 요청",
  );
  await page.clock.fastForward(3_599_000);
  await expect(resend).toBeDisabled();
  await page.clock.fastForward(1_000);
  await expect(resend).toBeEnabled();
});

test("ignores an old email's delayed challenge response", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/api/auth/signup/challenges", async (route) => {
    requested();
    await pending;
    await route.fulfill({
      status: 202,
      json: {
        status: "accepted",
        attemptToken: token,
        codeExpiresAt: at(600),
        resendAvailableAt: at(60),
      },
    });
  });
  await page.goto("/signup");
  await page.getByLabel("이메일", { exact: true }).fill("first@example.com");
  await page.getByRole("button", { name: "인증 요청", exact: true }).click();
  await started;
  await page.getByLabel("이메일", { exact: true }).fill("second@example.com");
  const responded = page.waitForResponse("**/api/auth/signup/challenges");
  release();
  await responded;
  await expect(page.getByLabel("인증번호", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("비밀번호", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "인증 요청", exact: true }),
  ).toBeEnabled();
});

test("reuses the operation key after a lost challenge response", async ({
  page,
}) => {
  const keys: string[] = [];
  await page.route("**/api/auth/signup/challenges", async (route) => {
    keys.push(route.request().postDataJSON().operationKey);
    if (keys.length === 1) await route.abort("failed");
    else
      await route.fulfill({
        status: 202,
        json: {
          status: "accepted",
          attemptToken: token,
          codeExpiresAt: at(600),
          resendAvailableAt: at(60),
        },
      });
  });
  await page.goto("/signup");
  await page.getByLabel("이메일", { exact: true }).fill("qa@example.com");
  const send = page.getByRole("button", { name: "인증 요청", exact: true });
  await send.click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await send.click();
  await expect(page.getByLabel("인증번호", { exact: true })).toBeEnabled();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[1]).toBe(keys[0]);
});

test("starts a new challenge after the old attempt has been cleaned up", async ({
  page,
}) => {
  await page.route("**/api/auth/signup/challenges/resend", (route) =>
    route.fulfill({
      status: 400,
      json: {
        code: "invalid_or_expired_challenge",
        message: "인증을 다시 진행해 주세요.",
      },
    }),
  );
  await page.goto("/signup");
  await page.getByLabel("이메일", { exact: true }).fill("qa@example.com");
  await page.getByRole("button", { name: "인증 요청", exact: true }).click();
  await page.clock.fastForward(60_000);
  await page.getByRole("button", { name: "재전송", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "인증 요청", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "인증 요청", exact: true }).click();
  await expect(page.getByLabel("인증번호", { exact: true })).toBeEnabled();
});

test("guides a consumed verification attempt to login", async ({ page }) => {
  await page.route("**/api/auth/signup/challenges/verify", (route) =>
    route.fulfill({ status: 400, json: { status: "already_completed" } }),
  );
  await verify(page);
  await expect(
    page.getByRole("heading", { name: "이미 가입 처리된 요청이에요" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "로그인하러 가기" }),
  ).toHaveAttribute("href", "/login");
  await expect(
    page.getByText("다시 입력한 비밀번호는 적용되지 않았어요.", {
      exact: false,
    }),
  ).toHaveCount(0);
});

test("recovers the request button if operation key generation fails", async ({
  page,
}) => {
  await page.addInitScript(() => {
    crypto.randomUUID = () => {
      throw new Error("UUID unavailable");
    };
  });
  await page.goto("/signup");
  await page.getByLabel("이메일", { exact: true }).fill("qa@example.com");
  await page.getByRole("button", { name: "인증 요청", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "인증 요청", exact: true }),
  ).toBeEnabled();
});

for (const step of ["request", "resend", "verify", "complete"] as const) {
  test(`honors Retry-After for a non-JSON signup ${step} response`, async ({
    page,
  }) => {
    if (step === "complete") {
      await verify(page);
      await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
      await page
        .getByLabel("비밀번호 확인", { exact: true })
        .fill("ValidPass1234");
    } else {
      await page.goto("/signup");
      await page.getByLabel("이메일", { exact: true }).fill("qa@example.com");
      if (step !== "request") {
        await page
          .getByRole("button", { name: "인증 요청", exact: true })
          .click();
      }
      if (step === "resend") await page.clock.fastForward(60_000);
      if (step === "verify") {
        await page.getByLabel("인증번호", { exact: true }).fill("123456");
      }
    }

    const endpoint =
      step === "request"
        ? "challenges"
        : step === "complete"
          ? "complete"
          : `challenges/${step}`;
    await page.route(`**/api/auth/signup/${endpoint}`, (route) =>
      route.fulfill({
        status: 429,
        contentType: "text/html",
        headers: { "retry-after": "90" },
        body:
          step === "resend" || step === "complete"
            ? ""
            : "<h1>Too many requests</h1>",
      }),
    );
    const action = page.getByRole("button", {
      name:
        step === "request"
          ? "인증 요청"
          : step === "resend"
            ? "재전송"
            : step === "verify"
              ? "인증 확인"
              : "회원가입",
      exact: true,
    });
    await action.click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "이후 다시 요청",
    );
    const blocked =
      step === "verify"
        ? page.getByRole("button", { name: "재전송", exact: true })
        : action;
    await expect(blocked).toBeDisabled();
    await page.clock.fastForward(89_000);
    await expect(blocked).toBeDisabled();
    await page.clock.fastForward(1_000);
    await expect(blocked).toBeEnabled();
  });
}
