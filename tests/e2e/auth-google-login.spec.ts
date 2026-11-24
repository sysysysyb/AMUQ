import { errors, expect, test } from "@playwright/test";

test.describe("final authentication regressions", () => {
  test.use({ timezoneId: "Asia/Seoul" });

  for (const code of ["invalid_request", "invalid_session"]) {
    test(`shows Google callback error ${code}`, async ({ page }) => {
      await page.goto(`/login?authError=${code}`);
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "Google 로그인 중 오류가 발생했습니다.",
      );
    });
  }

  for (const recovery of [
    "cached return",
    "cancelled navigation",
    "handoff timeout",
  ]) {
    test(`recovers Google handoff after ${recovery}`, async ({ page }) => {
      await page.clock.install();
      await page.route("**/api/auth/google/start", (route) =>
        route.fulfill({
          json: { authorizationUrl: new URL("/held-google", page.url()).href },
        }),
      );
      await page.goto("/login");
      await page.clock.pauseAt(new Date(Date.now() + 60_000));
      await page.evaluate((cancel) => {
        const held = new Promise<void>((resolve) =>
          window.addEventListener("fixture-release-google", () => resolve(), {
            once: true,
          }),
        );
        window.navigation.addEventListener("navigate", (event) => {
          if (new URL(event.destination.url).pathname !== "/held-google")
            return;
          if (cancel) event.preventDefault();
          else event.intercept({ handler: () => held });
          document.documentElement.dataset.googleNavigation = "requested";
        });
      }, recovery === "cancelled navigation");
      const click = page
        .getByRole("button", { name: "Google 계정으로 로그인" })
        .click({ noWaitAfter: true });
      try {
        await expect(page.locator("html")).toHaveAttribute(
          "data-google-navigation",
          "requested",
        );
        if (recovery !== "cancelled navigation") {
          await expect(
            page.getByRole("button", { name: /Google/ }),
          ).toBeDisabled();
          if (recovery === "handoff timeout") {
            await page.clock.fastForward(14_000);
            await expect(
              page.getByRole("button", { name: /Google/ }),
            ).toBeDisabled();
            await page.clock.fastForward(1_000);
          } else {
            await page.evaluate(() =>
              window.dispatchEvent(
                new PageTransitionEvent("pageshow", { persisted: true }),
              ),
            );
          }
        }
        await expect(
          page.getByRole("button", { name: "Google 계정으로 로그인" }),
        ).toBeEnabled();
        await expect(
          page.getByRole("button", { name: "로그인", exact: true }),
        ).toBeEnabled();
      } finally {
        await page.evaluate(() =>
          window.dispatchEvent(new Event("fixture-release-google")),
        );
        await click;
      }
    });
  }

  test("ignores unrelated navigation errors while a Google request is pending", async ({
    page,
  }) => {
    let requested = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/auth/google/start", async (route) => {
      requested = true;
      await held;
      await route.fulfill({
        status: 503,
        json: { message: "Google 로그인 연결을 다시 시도해주세요." },
      });
    });
    await page.goto("/login");
    await page.getByRole("button", { name: "Google 계정으로 로그인" }).click();
    try {
      await expect.poll(() => requested).toBe(true);
      await page.evaluate(() =>
        window.navigation.dispatchEvent(new ErrorEvent("navigateerror")),
      );
      await expect(
        page.getByRole("button", { name: "Google 연결 중", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "처리 중", exact: true }),
      ).toBeDisabled();
    } finally {
      release();
    }
    await expect(
      page.getByRole("button", { name: "Google 계정으로 로그인" }),
    ).toBeEnabled();
  });

  test("ignores a Google start response after leaving the login screen", async ({
    page,
  }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    await page.route("**/api/auth/google/start", async (route) => {
      requested = true;
      await held;
      await route.fulfill({
        json: { authorizationUrl: "/login?late-google-response=1" },
      });
    });
    await page.goto("/login");
    await page.getByRole("button", { name: "Google 계정으로 로그인" }).click();
    await expect.poll(() => requested).toBe(true);
    try {
      await page.getByRole("link", { name: "비밀번호를 잊으셨나요?" }).click();
      await expect(page).toHaveURL("/forgot-password");
      const unexpectedNavigation = page.waitForRequest(
        (request) =>
          request.isNavigationRequest() &&
          new URL(request.url()).searchParams.has("late-google-response"),
        { timeout: 1_000 },
      );
      const response = page.waitForResponse("**/api/auth/google/start");
      const settled = Promise.all([
        expect(unexpectedNavigation).rejects.toBeInstanceOf(
          errors.TimeoutError,
        ),
        response.then((result) => result.finished()),
      ]);
      release();
      await settled;
      await expect(page).toHaveURL("/forgot-password");
    } finally {
      release();
    }
  });
});

test.describe("authentication screens", () => {
  test("matches the desktop login structure and starts Google authentication", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/auth/google/start", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: { authorizationUrl: new URL("/mock-google", page.url()).href },
      });
    });

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "로그인" })).toBeVisible();
    await expect(page.getByText("아무 자료나")).toBeVisible();
    await expect(page.getByLabel("이메일")).toBeVisible();
    await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
    const google = page.getByRole("button", {
      name: "Google 계정으로 로그인",
    });
    await expect(google).toBeVisible();
    await expect(google).toHaveCSS(
      "transition-duration",
      /^(0\.3s)(, 0\.3s)*$/,
    );
    await expect(google).toHaveCSS(
      "transition-timing-function",
      /^(ease-in-out)(, ease-in-out)*$/,
    );

    await google.click();
    await expect(page).toHaveURL("/mock-google");
  });
});
