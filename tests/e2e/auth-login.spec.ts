import { expect, test } from "@playwright/test";

test.describe("final authentication regressions", () => {
  test.use({ timezoneId: "Asia/Seoul" });

  for (const scenario of [
    {
      status: 400,
      message: "요청을 확인해 주세요.",
      expected: "이메일 또는 비밀번호가 올바르지 않습니다.",
      password: "short123",
    },
    {
      status: 429,
      message: "요청이 너무 많습니다.",
      expected: "09시 15분",
      password: "ValidPass1234",
    },
    {
      status: 503,
      message: "로그인 서비스를 잠시 사용할 수 없습니다.",
      expected: "로그인 서비스를 잠시 사용할 수 없습니다.",
      password: "ValidPass1234",
    },
  ]) {
    test(`distinguishes login HTTP ${scenario.status} from invalid credentials`, async ({
      page,
    }) => {
      await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
      await page.route("**/api/auth/login", (route) =>
        route.fulfill({
          status: scenario.status,
          headers: { "retry-after": "900" },
          json: { message: scenario.message },
        }),
      );
      await page.goto("/login");
      await page.getByLabel("이메일").fill("qa@example.com");
      await page
        .getByLabel("비밀번호", { exact: true })
        .fill(scenario.password);
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        scenario.expected,
      );
      if (scenario.status !== 400) {
        await expect(
          page.getByRole("main").getByRole("alert"),
        ).not.toContainText("비밀번호가 올바르지");
      }
      await expect(
        page.getByRole("button", { name: "로그인", exact: true }),
      ).toBeEnabled();
    });
  }

  test("keeps password login disabled until navigation completes", async ({
    page,
  }) => {
    let release = () => {};
    const heldNavigation = new Promise<void>((resolve) => {
      release = resolve;
    });
    let navigationRequested = false;
    let loginResponded = false;
    await page.route(
      (url) => url.pathname === "/",
      async (route) => {
        if (loginResponded) navigationRequested = true;
        await heldNavigation;
        await route.continue();
      },
    );
    await page.route("**/api/auth/login", async (route) => {
      loginResponded = true;
      await route.fulfill({ json: { status: "authenticated" } });
    });
    await page.goto("/login");
    await page.getByLabel("이메일").fill("qa@example.com");
    await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
    const click = page
      .getByRole("button", { name: "로그인", exact: true })
      .click({ noWaitAfter: true });
    try {
      await expect.poll(() => navigationRequested).toBe(true);
      await expect(
        page.getByRole("button", { name: "처리 중", exact: true }),
      ).toBeDisabled();
    } finally {
      release();
      await click;
    }
  });
});

test.describe("authentication screens", () => {
  test("submits short login passwords without showing creation policy errors", async ({
    page,
  }) => {
    const passwords: unknown[] = [];
    await page.route("**/api/auth/login", (route) => {
      passwords.push(route.request().postDataJSON().password);
      return route.fulfill({
        status: 401,
        json: { code: "invalid_credentials" },
      });
    });
    for (const password of ["short", "x"]) {
      await page.goto("/login");
      await page.getByLabel("이메일").fill("qa@example.com");
      const field = page.getByLabel("비밀번호", { exact: true });
      await field.fill(password);
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "이메일 또는 비밀번호가 올바르지 않습니다.",
      );
      await expect(field).not.toHaveAttribute("aria-invalid", "true");
      await expect(field).not.toHaveAttribute("aria-describedby");
    }
    expect(passwords).toEqual(["short", "x"]);
  });

  test("prevents overlapping password and Google login requests", async ({
    page,
  }) => {
    let releaseLogin = () => {};
    let releaseGoogle = () => {};
    const loginGate = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    const googleGate = new Promise<void>((resolve) => {
      releaseGoogle = resolve;
    });
    await page.route("**/api/auth/login", async (route) => {
      await loginGate;
      await route.fulfill({ status: 401, json: {} });
    });
    await page.route("**/api/auth/google/start", async (route) => {
      await googleGate;
      await route.fulfill({
        status: 503,
        json: { message: "Google 로그인을 지금 사용할 수 없습니다." },
      });
    });
    await page.goto("/login");
    await page.getByLabel("이메일").fill("qa@example.com");
    await page
      .getByLabel("비밀번호", { exact: true })
      .fill("correct horse battery staple");
    const login = page.locator("form button[type=submit]");
    const google = page.getByRole("button", { name: "Google 계정으로 로그인" });
    try {
      await login.click();
      await expect(google).toBeDisabled();
      releaseLogin();
      await expect(login).toBeEnabled();
      await google.click();
      await expect(login).toBeDisabled();
      releaseGoogle();
      await expect(login).toBeEnabled();
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: /이메일 또는 비밀번호|Google 로그인/ }),
      ).toContainText("Google 로그인을 지금 사용할 수 없습니다.");
    } finally {
      releaseLogin();
      releaseGoogle();
    }
  });
});
