import type { Page } from "@playwright/test";

export const prepareSignup = async (
  page: Page,
  verify = true,
  email = "qa@example.com",
) => {
  await page.route("**/api/auth/signup/challenges", async (route) => {
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({
      status: 202,
      json: {
        status: "accepted",
        attemptToken: "a".repeat(64),
        codeExpiresAt: new Date(now + 600_000).toISOString(),
        resendAvailableAt: new Date(now + 60_000).toISOString(),
      },
    });
  });
  await page.route("**/api/auth/signup/challenges/verify", async (route) => {
    const now = await page.evaluate(() => Date.now());
    await route.fulfill({
      json: {
        status: "verified",
        signupProof: "b".repeat(64),
        proofExpiresAt: new Date(now + 1_800_000).toISOString(),
      },
    });
  });
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByRole("button", { name: "인증 요청", exact: true }).click();
  if (verify) {
    await page.getByLabel("인증번호", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "인증 확인", exact: true }).click();
  }
};
