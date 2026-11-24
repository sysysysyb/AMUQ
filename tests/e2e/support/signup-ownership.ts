import type { Page } from "@playwright/test";

export const epoch = Date.parse("2026-10-21T00:00:00Z");

export const at = (seconds: number) =>
  new Date(epoch + seconds * 1_000).toISOString();

export const token = "a".repeat(64);

export const installSignupOwnershipMocks = async (page: Page) => {
  await page.clock.install({ time: new Date(epoch) });
  await page.route("**/api/auth/signup/challenges", (route) =>
    route.fulfill({
      status: 202,
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
      json: {
        status: "verified",
        signupProof: "b".repeat(64),
        proofExpiresAt: at(1_800),
      },
    }),
  );
};

export const verify = async (page: Page) => {
  await page.goto("/signup");
  await page.getByLabel("이메일", { exact: true }).fill("qa@example.com");
  await page.getByRole("button", { name: "인증 요청", exact: true }).click();
  await page.getByLabel("인증번호", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "인증 확인", exact: true }).click();
};
