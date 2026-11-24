import { expect, test } from "@playwright/test";

test.describe("authentication screens", () => {
  test("retries account-link status after a failed connection", async ({
    page,
  }) => {
    let available = false;
    await page.route("**/api/auth/link/status", (route) =>
      available
        ? route.fulfill({
            json: { email: "qa@example.com", requiredProvider: "password" },
          })
        : route.abort("failed"),
    );
    await page.goto("/login/link");
    await expect(
      page.getByRole("alert").filter({ hasText: "다시 시도해주세요" }),
    ).toBeVisible();
    available = true;
    await page.getByRole("button", { name: "다시 시도", exact: true }).click();
    await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
  });

  for (const scenario of [
    {
      name: "expired proof",
      response: { json: { code: "account_link_required" } },
      invalid: true,
    },
    {
      name: "unclassified JSON response",
      response: { json: { message: "요청을 처리하지 못했습니다." } },
      invalid: false,
    },
    {
      name: "non-JSON response",
      response: { body: "Unauthorized" },
      invalid: false,
    },
  ]) {
    test(`classifies account-link status with ${scenario.name}`, async ({
      page,
    }) => {
      await page.route("**/api/auth/link/status", (route) =>
        route.fulfill({ status: 401, ...scenario.response }),
      );
      await page.goto("/login/link");
      const invalidHeading = page.getByRole("heading", {
        name: "계정 연결을 다시 시작해 주세요",
      });
      const retry = page.getByRole("button", {
        name: "다시 시도",
        exact: true,
      });
      if (scenario.invalid) {
        await expect(invalidHeading).toBeVisible();
        await expect(retry).toHaveCount(0);
      } else {
        await expect(retry).toBeVisible();
        await expect(invalidHeading).toHaveCount(0);
      }
    });
  }

  for (const scenario of [
    { provider: "password", moveFocus: false },
    { provider: "google", moveFocus: false },
    { provider: "password", moveFocus: true },
  ]) {
    test(`keeps keyboard focus through account-link ${scenario.provider} status retry${scenario.moveFocus ? " without stealing focus" : ""}`, async ({
      page,
    }) => {
      const endpoint = "**/api/auth/link/status";
      await page.route(endpoint, (route) => route.abort("failed"));
      await page.goto("/login/link");
      const retry = page.getByRole("button", {
        name: "다시 시도",
        exact: true,
      });
      await expect(retry).toBeVisible();
      await page.unroute(endpoint);
      let releaseStatus = () => {};
      const pendingStatus = new Promise<void>((resolve) => {
        releaseStatus = resolve;
      });
      await page.route(endpoint, async (route) => {
        await pendingStatus;
        await route.fulfill({
          json: {
            email: "qa@example.com",
            requiredProvider: scenario.provider,
          },
        });
      });
      await retry.focus();
      await retry.press("Enter");
      const loading = page.getByText("계정 연결 정보를 확인하고 있어요.", {
        exact: true,
      });
      try {
        await expect(loading).toBeFocused();
        await expect(loading).toHaveAttribute("role", "status");
        if (scenario.moveFocus) {
          await page.getByRole("link", { name: "개인정보 처리방침" }).focus();
        }
      } finally {
        releaseStatus();
      }
      const nextControl =
        scenario.provider === "password"
          ? page.getByLabel("비밀번호", { exact: true })
          : page.getByRole("button", {
              name: "Google 계정으로 로그인",
              exact: true,
            });
      await expect(nextControl).toBeVisible();
      await expect(
        scenario.moveFocus
          ? page.getByRole("link", { name: "개인정보 처리방침" })
          : nextControl,
      ).toBeFocused();
    });
  }

  for (const scenario of [
    { name: "another failure", invalid: false },
    { name: "expired proof", invalid: true },
  ]) {
    test(`keeps keyboard focus when account-link status retry returns ${scenario.name}`, async ({
      page,
    }) => {
      const endpoint = "**/api/auth/link/status";
      await page.route(endpoint, (route) => route.abort("failed"));
      await page.goto("/login/link");
      const retry = page.getByRole("button", {
        name: "다시 시도",
        exact: true,
      });
      await expect(retry).toBeVisible();
      await page.unroute(endpoint);
      let releaseStatus = () => {};
      const pendingStatus = new Promise<void>((resolve) => {
        releaseStatus = resolve;
      });
      await page.route(endpoint, async (route) => {
        await pendingStatus;
        await route.fulfill({
          status: scenario.invalid ? 401 : 503,
          json: {
            code: scenario.invalid ? "account_link_required" : "internal_error",
          },
        });
      });
      await retry.focus();
      await retry.press("Enter");
      try {
        await expect(page.getByRole("status")).toBeFocused();
      } finally {
        releaseStatus();
      }
      const resultControl = scenario.invalid
        ? page.getByRole("link", { name: "로그인으로 이동", exact: true })
        : retry;
      await expect(resultControl).toBeVisible();
      await expect(resultControl).toBeFocused();
    });
  }
});
