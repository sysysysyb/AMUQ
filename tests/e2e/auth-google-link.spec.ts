import { expect, test } from "@playwright/test";

test.describe("authentication screens", () => {
  test("moves a successful password login into the restricted Google-link flow", async ({
    page,
  }) => {
    let linkRequestBody: unknown;
    await page.route("**/api/auth/login", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: {
          requiredProvider: "google",
          status: "account_link_required",
        },
      });
    });
    await page.route("**/api/auth/link/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: { email: "abc@gmail.com", requiredProvider: "google" },
      });
    });
    await page.route("**/api/auth/link/google", async (route) => {
      linkRequestBody = route.request().postDataJSON();
      await route.fulfill({
        contentType: "application/json",
        json: { authorizationUrl: new URL("/mock-google", page.url()).href },
      });
    });

    await page.goto("/login");
    await page.getByLabel("이메일").fill("abc@gmail.com");
    await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
    await page.getByRole("button", { name: "로그인", exact: true }).click();

    await expect(page).toHaveURL("/login/link");
    await expect(
      page.getByText(/Google 계정으로 로그인하면.*연결/),
    ).toBeVisible();
    await expect(page.getByLabel("이메일")).toHaveCount(0);
    await expect(page.getByLabel("비밀번호", { exact: true })).toHaveCount(0);
    const google = page.getByRole("button", {
      name: "Google 계정으로 로그인",
    });
    await expect(google).toBeVisible();
    await google.click();
    expect(linkRequestBody).toEqual({ returnTo: "/" });
    await expect(page).toHaveURL("/mock-google");
  });

  test("prefills and disables the email for password confirmation, then announces completion", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.route("**/api/auth/link/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: { email: "abc@gmail.com", requiredProvider: "password" },
      });
    });
    let confirmations = 0;
    await page.route("**/api/auth/link/password", async (route) => {
      if (++confirmations > 1) {
        await route.fulfill({
          status: 401,
          json: { code: "account_link_required" },
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        json: {
          email: "abc@gmail.com",
          emailVerified: true,
          id: "0e448f42-4699-4ca2-8190-720133a4dfd2",
        },
      });
    });

    await page.goto("/login/link");

    const email = page.getByLabel("이메일");
    await expect(email).toHaveValue("abc@gmail.com");
    await expect(email).toBeDisabled();
    await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
    const infoIcon = page.getByRole("img", { name: "안내", exact: true });
    await expect(infoIcon).toBeVisible();
    await expect(infoIcon).toHaveAttribute("src", "/icons/info.svg");
    await expect(infoIcon).toHaveCSS("width", "20px");
    await expect(infoIcon).toHaveCSS("height", "20px");
    await expect(
      page.getByText(/비밀번호를 확인하면 Google 계정과 연결/),
    ).toBeVisible();

    await page
      .getByLabel("비밀번호", { exact: true })
      .fill("correct horse battery staple");
    await page.getByRole("button", { name: "동의하고 연결" }).click();

    await expect(page.getByRole("status")).toContainText(
      "계정 연결이 완료됐어요.",
    );
    expect(
      await page.getByRole("button", { name: "동의하고 연결" }).isDisabled(),
    ).toBe(true);
    await page.getByLabel("비밀번호", { exact: true }).press("Enter");
    await expect(page.getByRole("status")).toContainText(
      "계정 연결이 완료됐어요.",
    );
    expect(confirmations).toBe(1);
    await page.clock.runFor(1_200);
    await expect(page).toHaveURL("/");
  });

  test("keeps Google cancellation and password-session expiry inside the link flow", async ({
    page,
  }) => {
    await page.route("**/api/auth/link/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: { email: "abc@gmail.com", requiredProvider: "google" },
      });
    });
    await page.goto("/login/link?authError=provider_cancelled");
    await expect(
      page.getByRole("alert").filter({ hasText: /Google 로그인/ }),
    ).toContainText("Google 로그인이 취소됐습니다.");
    await expect(
      page.getByRole("img", { name: "오류", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Google 계정으로 로그인" }),
    ).toBeVisible();

    await page.unroute("**/api/auth/link/status");
    await page.route("**/api/auth/link/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: { email: "abc@gmail.com", requiredProvider: "password" },
      });
    });
    await page.route("**/api/auth/link/password", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        status: 401,
        json: {
          code: "account_link_required",
          message: "계정 연결 인증을 다시 진행해 주세요.",
        },
      });
    });
    await page.goto("/login/link");
    await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
    await page.getByRole("button", { name: "동의하고 연결" }).click();
    await expect(
      page.getByRole("heading", { name: "계정 연결을 다시 시작해 주세요" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "로그인으로 이동", exact: true }),
    ).toBeFocused();
  });

  test("clears the previous Google-link error while retrying", async ({
    page,
  }) => {
    await page.route("**/api/auth/link/status", (route) =>
      route.fulfill({
        json: { email: "qa@example.com", requiredProvider: "google" },
      }),
    );
    let requests = 0;
    let releaseRetry = () => {};
    const pendingRetry = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    await page.route("**/api/auth/link/google", async (route) => {
      if (++requests > 1) await pendingRetry;
      await route.fulfill({
        status: 503,
        json: {
          code: "provider_unavailable",
          message: "Google 로그인을 지금 사용할 수 없습니다.",
        },
      });
    });
    await page.goto("/login/link");
    const start = page.getByRole("button", {
      name: "Google 계정으로 로그인",
      exact: true,
    });
    const error = page
      .getByRole("alert")
      .filter({ hasText: "Google 로그인을 지금 사용할 수 없습니다." });
    await start.click();
    await expect(error).toBeVisible();
    await start.click();
    try {
      await expect(
        page.getByRole("button", { name: "Google 연결 중", exact: true }),
      ).toBeDisabled();
      await expect(error).toHaveCount(0);
    } finally {
      releaseRetry();
    }
    await expect(error).toBeVisible();
    await expect(start).toBeEnabled();
  });
  for (const width of [1440, 390, 320]) {
    test(`keeps the account-link toast in the top right after navigation at ${width}px`, async ({
      page,
    }) => {
      await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/api/auth/link/status", (route) =>
        route.fulfill({
          json: { email: "qa@example.com", requiredProvider: "password" },
        }),
      );
      await page.route("**/api/auth/link/password", (route) =>
        route.fulfill({ status: 200, json: { status: "linked" } }),
      );
      await page.goto("/login/link");
      await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
      await page.clock.pauseAt(
        (await page.evaluate(() => Date.now())) + 60_000,
      );
      await page.getByRole("button", { name: "동의하고 연결" }).click();
      const toast = page
        .getByRole("status")
        .filter({ hasText: "계정 연결 완료" });
      await expect(toast).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath("toast-before-navigation.png"),
      });
      await page.clock.runFor(1_200);
      await expect(page).toHaveURL("/");
      await expect(toast).toBeVisible();
      const bounds = (await toast.boundingBox())!;
      expect(bounds.y).toBeCloseTo(24, 0);
      expect(width - bounds.x - bounds.width).toBeCloseTo(24, 0);
      expect(bounds.width).toBeLessThanOrEqual(width - 48);
      const close = toast.getByRole("button", { name: "알림 닫기" });
      await expect(close).toHaveCSS("width", "44px");
      await close.focus();
      await close.press("Enter");
      await expect(toast).toHaveCount(0);
    });
  }
});
