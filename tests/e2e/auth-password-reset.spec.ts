import { expect, test } from "@playwright/test";

test.describe("final authentication regressions", () => {
  test.use({ timezoneId: "Asia/Seoul" });

  test("keeps password reset success after the original session expiry", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.route("**/api/auth/password-reset/session", (route) =>
      route.fulfill({ json: { expiresAt: "2026-01-01T00:03:00Z" } }),
    );
    await page.route("**/api/auth/password-reset/confirm", (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.goto("/reset-password?token=reset-token");
    await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
    await page
      .getByLabel("비밀번호 확인", { exact: true })
      .fill("ValidPass1234");
    await page
      .getByRole("button", { name: "비밀번호 변경", exact: true })
      .click();
    const success = page.getByRole("heading", {
      name: "비밀번호를 변경했어요",
    });
    await expect(success).toBeVisible();
    await page.clock.fastForward(4 * 60_000);
    await expect(success).toBeVisible();
  });
});

test.describe("authentication screens", () => {
  test("renders a dismissible warning toast while keeping the reset form usable", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    let expiresAt = 0;
    await page.route("**/api/auth/password-reset/session", async (route) => {
      expiresAt = (await page.evaluate(() => Date.now())) + 300_000;
      await route.fulfill({
        json: { expiresAt: new Date(expiresAt).toISOString() },
      });
    });
    for (const width of [1440, 390, 320]) {
      await page.clock.resume();
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/reset-password?token=warning-token");
      await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
      await page.clock.pauseAt(expiresAt - 90_000);
      const toast = page
        .getByRole("status")
        .filter({ hasText: "재설정 시간이 2분 남았어요." });
      await expect(toast).toHaveAttribute("data-kind", "toast");
      await expect(toast).toHaveAttribute("data-tone", "warning");
      await expect(toast.getByRole("img", { name: "주의" })).toBeVisible();
      const close = toast.getByRole("button", { name: "알림 닫기" });
      await expect(close).toHaveCSS("width", "44px");
      await expect(close).toHaveCSS("height", "44px");
      const bounds = (await toast.boundingBox())!;
      expect(bounds.width).toBeLessThanOrEqual(342);
      expect(bounds.y).toBeCloseTo(24, 0);
      await close.focus();
      await close.press("Enter");
      await expect(toast).toHaveCount(0);
      await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
    }
  });

  test("clears the reset warning when the reset session expires", async ({
    page,
  }) => {
    const now = new Date("2026-01-01T00:00:00Z");
    await page.clock.install({ time: now });
    const expiresAt = new Date(now.getTime() + 300_000);
    await page.route("**/api/auth/password-reset/session", (route) =>
      route.fulfill({
        json: { expiresAt: expiresAt.toISOString() },
      }),
    );
    await page.goto("/reset-password?token=warning-expiry");
    await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
    // Show the warning with only two seconds left, before its 3.2-second auto-dismiss.
    await page.clock.pauseAt(expiresAt.getTime() - 2_000);
    const warning = page
      .getByRole("status")
      .filter({ hasText: "재설정 시간 안내" });
    await expect(warning).toBeVisible();
    await page.clock.runFor(2_000);
    await expect(
      page.getByRole("heading", { name: "재설정 링크를 사용할 수 없어요" }),
    ).toBeVisible();
    await expect(warning).toHaveCount(0);
  });

  test("automatically removes a toast after three seconds and its fade", async ({
    page,
  }) => {
    const now = new Date("2026-01-01T00:00:00Z");
    const expiresAt = new Date(now.getTime() + 300_000);
    await page.clock.install({ time: now });
    await page.route("**/api/auth/password-reset/session", (route) =>
      route.fulfill({ json: { expiresAt: expiresAt.toISOString() } }),
    );
    await page.goto("/reset-password?token=warning-auto-dismiss");
    await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
    await page.clock.pauseAt(expiresAt.getTime() - 90_000);
    const warning = page
      .getByRole("status")
      .filter({ hasText: "재설정 시간 안내" });
    await expect(warning).toHaveCount(1);
    await page.clock.runFor(2_999);
    await expect(warning).toHaveCount(1);
    await page.clock.runFor(201);
    await expect(warning).toHaveCount(0);
    await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
  });

  test("keeps a valid reset form retryable after server errors", async ({
    page,
  }) => {
    await page.route("**/api/auth/password-reset/session", (route) =>
      route.fulfill({
        json: { expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
      }),
    );
    const failures = [500, 504];
    await page.route("**/api/auth/password-reset/confirm", (route) => {
      const status = failures.shift() ?? 204;
      return route.fulfill(
        status === 500
          ? {
              status,
              json: {
                code: "internal_error",
                message: "요청을 처리하지 못했습니다.",
              },
            }
          : { status, body: "" },
      );
    });
    await page.goto("/reset-password?token=server-retry");
    await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
    await page
      .getByLabel("비밀번호 확인", { exact: true })
      .fill("ValidPass1234");
    const submit = page.getByRole("button", {
      name: "비밀번호 변경",
      exact: true,
    });
    for (let index = 0; index < 2; index++) {
      await submit.click();
      const error = page
        .getByRole("alert")
        .filter({ hasText: "요청을 처리하지 못했습니다." });
      await expect(error).toHaveText(
        index === 0
          ? "요청을 처리하지 못했습니다."
          : "요청을 처리하지 못했습니다. 다시 시도해주세요.",
      );
      await expect(submit).toBeEnabled();
      await expect(
        page.getByRole("heading", { name: "재설정 링크를 사용할 수 없어요" }),
      ).toHaveCount(0);
    }
    await submit.click();
    await expect(
      page.getByRole("heading", { name: "비밀번호를 변경했어요" }),
    ).toBeVisible();
  });

  test("ignores retired verification links and exchanges reset tokens only once in React development mode", async ({
    page,
  }) => {
    let verificationRequests = 0;
    let resetRequests = 0;
    await page.route("**/api/auth/verify-email", async (route) => {
      verificationRequests += 1;
      await route.fulfill({
        contentType: "application/json",
        status: verificationRequests === 1 ? 200 : 400,
        json: verificationRequests === 1 ? { status: "verified" } : {},
      });
    });
    await page.goto("/verify-email?token=verification-token");
    await expect(
      page.getByRole("heading", { name: "이메일 인증을 다시 진행해 주세요" }),
    ).toBeVisible();
    expect(verificationRequests).toBe(0);

    await page.route("**/api/auth/password-reset/session", async (route) => {
      resetRequests += 1;
      await route.fulfill({
        contentType: "application/json",
        status: resetRequests === 1 ? 200 : 400,
        json:
          resetRequests === 1
            ? { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
            : {},
      });
    });
    await page.goto("/reset-password?token=reset-token");
    await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
    expect(resetRequests).toBe(1);
  });
});
