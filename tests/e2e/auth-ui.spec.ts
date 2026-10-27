import { errors, expect, type Page, test } from "@playwright/test";

const prepareSignup = async (
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
  test("reveals brand lines in sequence while respecting reduced motion and mobile layout", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/login");
    const panel = page.getByTestId("auth-brand-panel");
    const first = panel.getByText("아무 자료나");
    const second = panel.getByText("Question으로.");
    await expect(first).toHaveCSS("animation-name", "auth-brand-enter");
    await expect(second).toHaveCSS("animation-name", "auth-brand-enter");
    const sequence = await panel.evaluate((element) => {
      const animations = element.getAnimations({ subtree: true });
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 0;
      }
      return animations.map((animation) => ({
        delay: animation.effect!.getTiming().delay,
        duration: Number(animation.effect!.getTiming().duration),
      }));
    });
    expect(sequence).toHaveLength(2);
    expect(sequence[0]!.duration).toBeGreaterThan(0);
    expect(sequence[1]!.delay).toBeGreaterThan(sequence[0]!.delay);
    await expect(first).toHaveCSS("opacity", "0");
    await expect(second).toHaveCSS("opacity", "0");
    await expect(first).toHaveCSS("transform", /matrix\(1, 0, 0, 1, -\d+, 0\)/);
    await panel.evaluate((element) => {
      const animations = element.getAnimations({ subtree: true });
      const secondDelay = animations[1]!.effect!.getTiming().delay;
      for (const animation of animations)
        animation.currentTime = secondDelay / 2;
    });
    expect(
      Number(
        await first.evaluate((element) => getComputedStyle(element).opacity),
      ),
    ).toBeGreaterThan(0);
    await expect(second).toHaveCSS("opacity", "0");
    await page.getByLabel("이메일").focus();
    await expect(page.getByLabel("이메일")).toBeFocused();
    await panel.evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true })) {
        const timing = animation.effect!.getTiming();
        animation.currentTime = timing.delay + Number(timing.duration);
      }
    });
    await expect(first).toHaveCSS("opacity", "1");
    await expect(second).toHaveCSS("opacity", "1");
    await expect(first).toHaveCSS(
      "transform",
      /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/,
    );
    await expect(second).toHaveCSS(
      "transform",
      /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/,
    );

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(first).toHaveCSS("animation-name", "none");
    await expect(second).toHaveCSS("animation-name", "none");
    await expect(first).toHaveCSS("opacity", "1");
    await expect(second).toHaveCSS("opacity", "1");
    await expect(first).toHaveCSS("transform", "none");
    await expect(second).toHaveCSS("transform", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(panel).toBeHidden();
    await expect(page.getByLabel("이메일")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "로그인", exact: true }),
    ).toBeEnabled();
  });

  test("grows new login alerts and animates only changed messages while preserving the box", async ({
    page,
  }) => {
    let releaseGoogle = () => {};
    const pendingGoogle = new Promise<void>((resolve) => {
      releaseGoogle = resolve;
    });
    let releaseLogin = () => {};
    const pendingLogin = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    let loginAttempts = 0;
    await page.route("**/api/auth/login", async (route) => {
      if (++loginAttempts > 1) await pendingLogin;
      await route.fulfill({ status: 401, json: {} });
    });
    await page.route("**/api/auth/google/start", async (route) => {
      await pendingGoogle;
      await route.fulfill({
        status: 503,
        json: { message: "Google 로그인을 지금 사용할 수 없습니다." },
      });
    });
    await page.goto("/login");
    await page.getByLabel("이메일").fill("qa@example.com");
    await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText(
      "이메일 또는 비밀번호가 올바르지 않습니다.",
    );
    await expect(alert).not.toContainText("로그인 실패");
    await expect(alert).toHaveCSS("animation-name", /feedback-grow-opacity/);
    const original = (await alert.elementHandle())!;
    try {
      await alert.evaluate((element) => {
        for (const animation of element.getAnimations({ subtree: true })) {
          animation.pause();
          animation.currentTime = 300;
        }
        const main = element.closest("main")!;
        const observer = new MutationObserver(() => {
          if (
            ![...main.querySelectorAll("button")].some(
              (button) => button.textContent === "로그인",
            )
          )
            return;
          const animations = element.getAnimations({ subtree: true });
          for (const animation of animations) animation.pause();
          element.setAttribute(
            "data-login-repeat",
            JSON.stringify(
              animations.map((animation) => ({
                name: (animation as CSSAnimation).animationName,
                time: animation.currentTime,
              })),
            ),
          );
          observer.disconnect();
        });
        observer.observe(main, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "처리 중", exact: true }),
      ).toBeDisabled();
      expect(await original.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      releaseLogin();
      await expect(
        page.getByRole("button", { name: "Google 계정으로 로그인" }),
      ).toBeEnabled();
      expect(
        JSON.parse((await alert.getAttribute("data-login-repeat")) ?? "[]"),
      ).toEqual([{ name: "feedback-content", time: 0 }]);
      await alert.evaluate((element) => {
        for (const animation of element.getAnimations()) {
          animation.pause();
          animation.currentTime = 300;
        }
        const observer = new MutationObserver(() => {
          if (!element.textContent?.includes("Google")) return;
          const animations = element.getAnimations({ subtree: true });
          for (const animation of animations) animation.pause();
          element.setAttribute(
            "data-replay",
            JSON.stringify(
              animations.map((animation) => ({
                name: (animation as CSSAnimation).animationName,
                time: animation.currentTime,
              })),
            ),
          );
          observer.disconnect();
        });
        observer.observe(element, {
          subtree: true,
          characterData: true,
          childList: true,
        });
      });
      await page
        .getByRole("button", { name: "Google 계정으로 로그인" })
        .click();
      await expect(
        page.getByRole("button", { name: "Google 연결 중" }),
      ).toBeDisabled();
      expect(await original.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      releaseGoogle();
      await expect(alert).toContainText(
        "Google 로그인을 지금 사용할 수 없습니다.",
      );
      expect(await original.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      expect(
        JSON.parse((await alert.getAttribute("data-replay")) ?? "[]"),
      ).toEqual([{ name: "feedback-content", time: 0 }]);
      await expect(alert).toHaveCSS("animation-name", "none");
      await expect(alert).toHaveCSS("opacity", "1");
      await expect(alert).toHaveCSS("transform", "none");
      const content = alert.locator("div").first();
      await expect(content).toHaveCSS("animation-name", "feedback-content");
      await content.evaluate((element) => {
        element.getAnimations()[0].currentTime = 100;
        const main = element.closest("main")!;
        const observer = new MutationObserver(() => {
          if (
            ![...main.querySelectorAll("button")].some(
              (button) => button.textContent === "Google 계정으로 로그인",
            )
          )
            return;
          for (const animation of element.getAnimations()) animation.pause();
          element.setAttribute(
            "data-repeat-time",
            String(element.getAnimations()[0].currentTime),
          );
          observer.disconnect();
        });
        observer.observe(main, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
      await page
        .getByRole("button", { name: "Google 계정으로 로그인" })
        .click();
      await expect(
        page.getByRole("button", { name: "Google 계정으로 로그인" }),
      ).toBeEnabled();
      await expect(content).toHaveAttribute("data-repeat-time", "0");
      await alert.evaluate((element) => {
        const observer = new MutationObserver(() => {
          if (element.textContent?.includes("Google")) return;
          const animations = element.getAnimations({ subtree: true });
          for (const animation of animations) animation.pause();
          element.setAttribute(
            "data-replay",
            JSON.stringify(
              animations.map((animation) => ({
                name: (animation as CSSAnimation).animationName,
                time: animation.currentTime,
              })),
            ),
          );
          observer.disconnect();
        });
        observer.observe(element, {
          subtree: true,
          characterData: true,
          childList: true,
        });
      });
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      await expect(alert).toContainText(
        "이메일 또는 비밀번호가 올바르지 않습니다.",
      );
      expect(await original.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      expect(
        JSON.parse((await alert.getAttribute("data-replay")) ?? "[]"),
      ).toEqual([{ name: "feedback-content", time: 0 }]);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(alert).toHaveCSS("animation-name", "none");
      await expect(alert).toHaveCSS("transform", "none");
      await expect(content).toHaveCSS("animation-name", "none");
      await expect(content).toHaveCSS("transform", "none");
      await expect(alert).toContainText(
        "이메일 또는 비밀번호가 올바르지 않습니다.",
      );
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto("/login");
      await page.getByLabel("이메일").fill("qa@example.com");
      await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      await expect(alert).toHaveCSS("animation-name", /feedback-grow-opacity/);
    } finally {
      releaseLogin();
      releaseGoogle();
    }
  });

  test("toggles password visibility without submitting or bypassing password validation", async ({
    page,
  }) => {
    let submissions = 0;
    await page.route("**/api/auth/signup/complete", (route) => {
      submissions++;
      return route.fulfill({ status: 202, json: {} });
    });
    await page.goto("/signup");
    await prepareSignup(page);
    const password = page.getByLabel("비밀번호", { exact: true });
    const confirmation = page.getByLabel("비밀번호 확인", { exact: true });
    await password.fill("short");
    await expect(password).toHaveAttribute("type", "password");
    const toggle = page.getByRole("button", {
      name: "비밀번호 표시",
      exact: true,
    });
    await toggle.click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(password).toHaveValue("short");
    await expect(confirmation).toHaveAttribute("type", "password");
    await expect(
      page.getByRole("button", { name: "비밀번호 숨기기", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(submissions).toBe(0);
    await confirmation.fill("short");
    await page.getByRole("button", { name: "회원가입" }).click();
    await expect(password).toHaveAccessibleDescription(
      "비밀번호는 12~20자로, 영문 대문자와 소문자 및 숫자를 포함해주세요.",
    );
    expect(submissions).toBe(0);
    await password.fill("ValidPass1234");
    await confirmation.fill("ValidPass1234");
    const hide = page.getByRole("button", {
      name: "비밀번호 숨기기",
      exact: true,
    });
    await hide.focus();
    await hide.press("Enter");
    await expect(password).toHaveAttribute("type", "password");
    await expect(password).toHaveValue("ValidPass1234");
    expect(submissions).toBe(0);
    await page
      .getByRole("button", { name: "비밀번호 확인 표시", exact: true })
      .click();
    await expect(confirmation).toHaveAttribute("type", "text");
    await expect(confirmation).toHaveValue("ValidPass1234");
    await expect(password).toHaveAttribute("type", "password");
    const hideConfirmation = page.getByRole("button", {
      name: "비밀번호 확인 숨기기",
      exact: true,
    });
    await hideConfirmation.focus();
    await hideConfirmation.press("Enter");
    await expect(confirmation).toHaveAttribute("type", "password");
    await expect(confirmation).toHaveValue("ValidPass1234");
    expect(submissions).toBe(0);
  });

  test("reports successful email resends and disables exhausted reset quotas", async ({
    page,
  }) => {
    await page.clock.install();
    {
      const endpoint = "**/api/auth/password-reset/resend";
      let calls = 0;
      await page.route(endpoint, (route) => {
        calls++;
        return route.fulfill({
          status: 202,
          json: {
            status: "accepted",
            rateLimit: {
              limit: 3,
              remaining: 2 - ((calls - 1) % 3),
              retryAfterSeconds: 60,
            },
          },
        });
      });
      await page.route("**/api/auth/password-reset/request", (route) =>
        route.fulfill({
          status: 202,
          json: {
            status: "accepted",
            rateLimit: { limit: 3, remaining: 2, retryAfterSeconds: 60 },
          },
        }),
      );
      await page.goto("/forgot-password");
      await page.getByLabel("이메일").fill("qa@example.com");
      await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
      const button = page.getByRole("button", {
        name: "메일 다시 보내기",
        exact: true,
      });
      await button.click();
      await expect(page.getByRole("status")).toHaveText(
        "재전송이 완료됐습니다. (1/3)",
      );
      await button.click();
      await expect(page.getByRole("status")).toHaveText(
        "재전송이 완료됐습니다. (2/3)",
      );
      await expect(button).toBeEnabled();
      await button.click();
      await expect(page.getByRole("status")).toHaveText(
        "재전송이 완료됐습니다. (3/3)",
      );
      await expect(button).toBeDisabled();
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "부터 메일을 다시 보낼 수 있어요.",
      );
      expect(calls).toBe(3);
      await page.clock.fastForward(60_000);
      await expect(button).toBeEnabled();
      await button.click();
      await expect(page.getByRole("status")).toHaveText(
        "재전송이 완료됐습니다. (1/3)",
      );
      await button.click();
      await button.click();
      await expect(page.getByRole("status")).toHaveText(
        "재전송이 완료됐습니다. (3/3)",
      );
      await expect(button).toBeDisabled();
      expect(calls).toBe(6);
      await page.unroute(endpoint);
    }
  });

  test("locks email resend buttons on 429 and restores them after Retry-After", async ({
    page,
  }) => {
    await page.clock.install();
    {
      const endpoint = "**/api/auth/password-reset/resend";
      let calls = 0;
      await page.route(endpoint, (route) => {
        calls++;
        return route.fulfill({
          status: 429,
          json: { code: "rate_limit_exceeded" },
          headers: { "retry-after": "60" },
        });
      });
      await page.route("**/api/auth/password-reset/request", (route) =>
        route.fulfill({
          status: 202,
          json: {
            status: "accepted",
            rateLimit: { limit: 3, remaining: 2, retryAfterSeconds: 60 },
          },
        }),
      );
      await page.goto("/forgot-password");
      await page.getByLabel("이메일").fill("qa@example.com");
      await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
      const button = page.getByRole("button", {
        name: "메일 다시 보내기",
        exact: true,
      });
      await button.click();
      await expect(button).toBeDisabled();
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        "부터 메일을 다시 보낼 수 있어요.",
      );
      await expect(page.getByRole("main").getByRole("status")).toBeEmpty();
      const blockedCalls = calls;
      await page.clock.fastForward(59_000);
      await expect(button).toBeDisabled();
      expect(calls).toBe(blockedCalls);
      await page.clock.fastForward(1_000);
      await expect(button).toBeEnabled();
      await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
      await page.unroute(endpoint);
    }
  });

  test("uses the Figma inset shadow while authentication buttons are pressed", async ({
    page,
  }) => {
    await page.route("**/api/auth/**", (route) =>
      route.fulfill({ status: 202, json: {} }),
    );
    await page.goto("/login");
    for (const name of ["로그인", "Google 계정으로 로그인"]) {
      const button = page.getByRole("button", { name, exact: true });
      const bounds = (await button.boundingBox())!;
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await page.mouse.down();
      try {
        await expect(button).toHaveCSS(
          "box-shadow",
          /rgba\(23, 34, 34, 0\.18\).*2px 2px.*inset/,
        );
      } finally {
        await page.mouse.move(0, 0);
        await page.mouse.up();
      }
    }
    await page.goto("/forgot-password");
    await page.getByLabel("이메일").fill("qa@example.com");
    await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
    const secondary = page.getByRole("button", { name: "메일 다시 보내기" });
    const bounds = (await secondary.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.down();
    try {
      await expect(secondary).toHaveCSS(
        "box-shadow",
        /rgba\(23, 34, 34, 0\.18\).*2px 2px.*inset/,
      );
    } finally {
      await page.mouse.move(0, 0);
      await page.mouse.up();
    }
  });

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

  test("keeps the signup verification description in one paragraph", async ({
    page,
  }) => {
    await page.route("**/api/auth/signup/complete", (route) =>
      route.fulfill({ status: 202, json: {} }),
    );
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/signup");
      await prepareSignup(page, false);
      const description = page.getByText(
        "이메일에서 인증번호 6자리를 확인해주세요.",
        { exact: false },
      );
      await expect(description).toBeVisible();
      expect(await description.evaluate((element) => element.tagName)).toBe(
        "P",
      );
    }
  });

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

  test("enforces email limits and the new password policy before signup", async ({
    page,
  }) => {
    let requests = 0;
    await page.route("**/api/auth/signup/complete", async (route) => {
      requests += 1;
      await route.fulfill({ json: { status: "created" } });
    });
    for (const scenario of [
      {
        email: `${"q".repeat(242)}@example.com`,
        password: "ValidPass1234",
        valid: true,
      },
      {
        email: `${"q".repeat(243)}@example.com`,
        password: "ValidPass1234",
        valid: false,
      },
      ...[
        ["Abcdef12345", false],
        ["ValidPass123", true],
        ["ValidPass12345678901", true],
        ["Abcdef123456789012345", false],
        ["lowercase1234", false],
        ["UPPERCASE1234", false],
        ["MixedCaseOnly", false],
        ["😀".repeat(12), false],
        ["Ab1" + "😀".repeat(9), true],
      ].map(([password, valid]) => ({
        email: "qa@example.com",
        password: String(password),
        valid: Boolean(valid),
      })),
    ]) {
      await page.goto("/signup");
      const before = requests;
      if (scenario.email.length > 254) {
        await page.getByLabel("이메일").fill(scenario.email);
        await page
          .getByRole("button", { name: "인증 요청", exact: true })
          .click();
        await expect(page.getByLabel("이메일")).toHaveAccessibleDescription(
          "이메일은 254자 이하로 입력해주세요.",
        );
        expect(requests).toBe(before);
        continue;
      }
      await prepareSignup(page, true, scenario.email);
      await page
        .getByLabel("비밀번호", { exact: true })
        .fill(scenario.password);
      await page
        .getByLabel("비밀번호 확인", { exact: true })
        .fill(scenario.password);
      await page.getByRole("button", { name: "회원가입" }).click();
      if (scenario.valid) {
        await expect(
          page.getByRole("heading", { name: "회원가입이 완료되었습니다!" }),
        ).toBeVisible();
        expect(requests).toBe(before + 1);
      } else {
        const field = page.getByLabel(
          scenario.email.length > 254 ? "이메일" : "비밀번호",
          { exact: true },
        );
        await expect(field).toHaveAccessibleDescription(
          scenario.email.length > 254
            ? "이메일은 254자 이하로 입력해주세요."
            : "비밀번호는 12~20자로, 영문 대문자와 소문자 및 숫자를 포함해주세요.",
        );
        expect(requests).toBe(before);
      }
    }
  });

  test("rejects email formats that the server rejects before sending a request", async ({
    page,
  }) => {
    let requests = 0;
    await page.route("**/api/auth/password-reset/request", async (route) => {
      requests += 1;
      await route.fulfill({ status: 202, json: {} });
    });
    for (const value of [
      "qa@localhost",
      ".qa@example.com",
      "qa..test@example.com",
    ]) {
      await page.goto("/forgot-password");
      const email = page.getByLabel("이메일");
      await email.fill(value);
      await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
      await expect(email).toHaveAccessibleDescription(
        "이메일 형식으로 입력해주세요.",
      );
    }
    expect(requests).toBe(0);
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

  test("recovers from failed connections without showing reset success", async ({
    page,
  }) => {
    await page.route("**/api/auth/password-reset/request", (route) =>
      route.abort("failed"),
    );
    await page.goto("/forgot-password");
    await page.getByLabel("이메일").fill("qa@example.com");
    await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "메일 요청에 연결할 수 없습니다." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "재설정 메일 보내기" }),
    ).toBeEnabled();
    await expect(
      page.getByText(
        "보안을 위해 해당 이메일의 가입 여부는 알려드리지 않아요.",
        { exact: true },
      ),
    ).toHaveCount(0);
    await page.unroute("**/api/auth/password-reset/request");
    await page.route("**/api/auth/password-reset/request", (route) =>
      route.fulfill({ status: 202, json: {} }),
    );
    await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
    await expect(
      page.getByText(
        "보안을 위해 해당 이메일의 가입 여부는 알려드리지 않아요.",
        { exact: true },
      ),
    ).toBeVisible();

    await page.route("**/api/auth/login", (route) => route.abort("failed"));
    await page.goto("/login");
    await page.getByLabel("이메일").fill("qa@example.com");
    await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "로그인 요청을 처리하지 못했습니다." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "로그인", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Google 계정으로 로그인" }),
    ).toBeEnabled();
    await page.unroute("**/api/auth/login");
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({ status: 401, json: {} }),
    );
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "이메일 또는 비밀번호가 올바르지 않습니다." }),
    ).toBeVisible();

    await page.route("**/api/auth/google/start", (route) =>
      route.abort("failed"),
    );
    await page.goto("/login");
    await page.getByRole("button", { name: "Google 계정으로 로그인" }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Google 로그인에 연결할 수 없습니다." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Google 계정으로 로그인" }),
    ).toBeEnabled();
    await page.unroute("**/api/auth/google/start");
    await page.route("**/api/auth/google/start", (route) =>
      route.fulfill({
        json: { authorizationUrl: new URL("/", page.url()).href },
      }),
    );
    await page.getByRole("button", { name: "Google 계정으로 로그인" }).click();
    await expect(page).toHaveURL("/");
  });

  test("shows field validation below inputs without sending invalid forms", async ({
    page,
  }) => {
    let requests = 0;
    await page.route("**/api/auth/**", async (route) => {
      requests += 1;
      await route.fulfill({ status: 202, json: {} });
    });
    for (const [path, button] of [
      ["/login", "로그인"],
      ["/signup", "인증 요청"],
      ["/forgot-password", "재설정 메일 보내기"],
    ]) {
      await page.goto(path!);
      const email = page.getByLabel("이메일", { exact: true });
      await email.fill("not-an-email");
      await page.getByRole("button", { name: button!, exact: true }).click();
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await expect(email).toHaveAccessibleDescription(
        "이메일 형식으로 입력해주세요.",
      );
      const message = page.getByText("이메일 형식으로 입력해주세요.", {
        exact: true,
      });
      await expect(message).toHaveCSS("color", "rgb(159, 36, 26)");
      expect((await message.boundingBox())!.y).toBeGreaterThan(
        (await email.boundingBox())!.y,
      );
      await email.fill("qa@example.com");
      await expect(message).toHaveCount(0);
    }
    await page.goto("/signup");
    await prepareSignup(page);
    const password = page.getByLabel("비밀번호", { exact: true });
    const confirmation = page.getByLabel("비밀번호 확인", { exact: true });
    for (const value of ["short", "Ab1" + "x".repeat(18)]) {
      await password.fill(value);
      await confirmation.fill("ValidPass1234");
      await page.getByRole("button", { name: "회원가입" }).click();
      await expect(password).toHaveAccessibleDescription(
        "비밀번호는 12~20자로, 영문 대문자와 소문자 및 숫자를 포함해주세요.",
      );
      await expect(password).toHaveAttribute("aria-invalid", "true");
    }
    await password.fill("ValidPass1234");
    await expect(password).not.toHaveAttribute("aria-invalid", "true");
    expect(requests).toBe(0);
  });

  test("places credential and Google failures in the designed inline alert", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1028 });
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({
        status: 401,
        json: { code: "invalid_credentials" },
      }),
    );
    await page.route("**/api/auth/google/start", (route) =>
      route.fulfill({
        status: 503,
        json: { message: "Google 로그인을 지금 사용할 수 없습니다." },
      }),
    );
    await page.goto("/login");
    await page.getByLabel("이메일").fill("qa@example.com");
    await page.getByLabel("비밀번호", { exact: true }).fill("ValidPass1234");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    const alert = page
      .getByRole("alert")
      .filter({ hasText: /이메일 또는 비밀번호|Google 로그인/ });
    await expect(alert).toContainText(
      "이메일 또는 비밀번호가 올바르지 않습니다.",
    );
    await expect(alert).toHaveCSS("background-color", "rgb(253, 236, 236)");
    expect((await alert.boundingBox())!.y).toBeGreaterThan(
      (await page.locator("form").boundingBox())!.y,
    );
    expect((await alert.boundingBox())!.y).toBeLessThan(
      (await page
        .getByRole("button", { name: "Google 계정으로 로그인" })
        .boundingBox())!.y,
    );
    await page.getByRole("button", { name: "Google 계정으로 로그인" }).click();
    await expect(alert).toContainText(
      "Google 로그인을 지금 사용할 수 없습니다.",
    );
    await expect(alert).not.toContainText("이메일 또는 비밀번호");
    await page.goto("/login?authError=provider_cancelled");
    await expect(alert).toContainText("Google 로그인이 취소됐습니다.");
  });

  test("shows signup confirmation errors below the field while reset errors stay inline", async ({
    page,
  }) => {
    await page.route("**/api/auth/password-reset/session", (route) =>
      route.fulfill({
        json: { expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
      }),
    );
    for (const [path, button] of [
      ["/signup", "회원가입"],
      ["/reset-password?token=qa-reset", "비밀번호 변경"],
    ]) {
      for (const confirmation of ["AnotherPass123", "short"]) {
        await page.goto(path!);
        if (path === "/signup") await prepareSignup(page);
        await page
          .getByLabel("비밀번호", { exact: true })
          .fill("ValidPass1234");
        await page
          .getByLabel("비밀번호 확인", { exact: true })
          .fill(confirmation);
        await page.getByRole("button", { name: button! }).click();
        const alert = page.getByRole("alert").filter({
          hasText:
            path === "/signup"
              ? "비밀번호와 일치하지 않습니다."
              : "비밀번호가 서로 일치하지 않습니다.",
        });
        if (path === "/signup") {
          const field = page.getByLabel("비밀번호 확인", { exact: true });
          await expect(field).toHaveAccessibleDescription(
            "비밀번호와 일치하지 않습니다.",
          );
          await expect(field).toHaveAttribute("aria-invalid", "true");
          await expect(alert).toHaveCSS("color", "rgb(159, 36, 26)");
          await expect(alert.getByRole("img")).toHaveCount(0);
          expect((await alert.boundingBox())!.y).toBeGreaterThan(
            (await field.boundingBox())!.y,
          );
          await field.fill("ValidPass1234");
          await expect(alert).toHaveCount(0);
          await expect(field).not.toHaveAttribute("aria-invalid", "true");
        } else {
          await expect(
            alert.getByRole("img", { name: "오류", exact: true }),
          ).toBeVisible();
          await expect(alert).toHaveCSS(
            "background-color",
            "rgb(253, 236, 236)",
          );
        }
      }
    }
  });

  test("shows reset rate limits on the first request after revisiting", async ({
    page,
  }) => {
    await page.route("**/api/auth/password-reset/request", (route) =>
      route.fulfill({
        status: 429,
        headers: { "retry-after": "60" },
        json: { code: "rate_limit_exceeded" },
      }),
    );
    for (let visit = 0; visit < 2; visit += 1) {
      await page.goto("/forgot-password");
      await page.getByLabel("이메일").fill("qa@example.com");
      await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "부터 메일을 다시 보낼 수 있어요." });
      await expect(alert).toContainText("부터 메일을 다시 보낼 수 있어요.");
      await expect(
        page.getByText(
          "보안을 위해 해당 이메일의 가입 여부는 알려드리지 않아요.",
          { exact: true },
        ),
      ).toHaveCount(0);
      await page.goto("/login");
    }
  });

  test("centers reset success copy and does not report failed requests as sent", async ({
    page,
  }) => {
    await page.route("**/api/auth/password-reset/request", (route) =>
      route.fulfill({
        status: 503,
        json: { message: "메일을 지금 보낼 수 없습니다." },
      }),
    );
    await page.goto("/forgot-password");
    await page.getByLabel("이메일").fill("qa@example.com");
    await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "메일을 지금 보낼 수 없습니다." }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "보안을 위해 해당 이메일의 가입 여부는 알려드리지 않아요.",
        { exact: true },
      ),
    ).toHaveCount(0);
    await page.unroute("**/api/auth/password-reset/request");
    await page.route("**/api/auth/password-reset/request", (route) =>
      route.fulfill({ status: 202, json: {} }),
    );
    await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
    await expect(
      page.getByText("계정이 있다면 재설정 링크를 보냈어요.", { exact: true }),
    ).toHaveCSS("text-align", "center");
  });

  test("keeps autofilled input surfaces white without hiding keyboard focus", async ({
    page,
  }) => {
    await page.goto("/login");
    const input = page.getByLabel("이메일");
    await input.fill("qa@example.com");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "input[name=email]",
    });
    await cdp.send("CSS.forcePseudoState", {
      nodeId,
      forcedPseudoClasses: ["autofill"],
    });
    await input.focus();
    await expect(input).toHaveCSS(
      "box-shadow",
      /rgb\(255, 255, 255\).*inset|inset.*rgb\(255, 255, 255\)/,
    );
    await expect(input).toHaveCSS("box-shadow", /rgba\(23, 104, 115, 0\.16\)/);
    await cdp.detach();
  });

  test("floats autofill preview labels before browser values are committed", async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/login");
      const { root } = await cdp.send("DOM.getDocument");
      for (const name of ["email", "password"]) {
        const input = page.locator(`input[name=${name}]`);
        const label = page.locator(
          `label[for="${await input.getAttribute("id")}"]`,
        );
        await expect(input).not.toBeFocused();
        await expect(input).toHaveValue("");
        const { nodeId } = await cdp.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: `input[name=${name}]`,
        });
        await cdp.send("CSS.forcePseudoState", {
          nodeId,
          forcedPseudoClasses: ["autofill"],
        });
        await expect(label).toHaveCSS("top", width < 768 ? "-8px" : "0px");
        await expect(label).toHaveCSS("font-size", "12px");
        await cdp.send("CSS.forcePseudoState", {
          nodeId,
          forcedPseudoClasses: [],
        });
        await expect(label).toHaveCSS("top", width < 768 ? "14px" : "22px");
        await expect(label).toHaveCSS("font-size", "14px");
      }
    }
    await cdp.detach();
  });

  test("provides 44px targets for account and footer links", async ({
    page,
  }) => {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/login");
      for (const link of await page.getByRole("link").all()) {
        const bounds = await link.boundingBox();
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
      await page
        .getByRole("link", { name: "비밀번호를 잊으셨나요?" })
        .click({ position: { x: 1, y: 1 } });
      await expect(page).toHaveURL("/forgot-password");
    }
  });

  test("fits short auth content and scrolls long content without clipping", async ({
    page,
  }) => {
    const longMessage =
      "긴 안내 내용을 끝까지 확인할 수 있어야 합니다. ".repeat(100);
    await page.route("**/api/auth/google/start", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        status: 503,
        json: { message: longMessage },
      });
    });
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1440, height: 700 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/login");
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.evaluate(() => {
        const main = document.querySelector("main")!;
        const padding = getComputedStyle(main);
        return {
          contentHeight:
            main.querySelector("section")!.getBoundingClientRect().height +
            Number.parseFloat(padding.paddingTop) +
            Number.parseFloat(padding.paddingBottom) +
            document.querySelector("footer")!.getBoundingClientRect().height,
          height: document.documentElement.scrollHeight,
          width: document.documentElement.scrollWidth,
        };
      });
      expect(layout.width).toBeLessThanOrEqual(viewport.width);
      expect(layout.height).toBeLessThanOrEqual(
        Math.max(viewport.height, Math.ceil(layout.contentHeight)) + 1,
      );

      await page
        .getByRole("button", { name: "Google 계정으로 로그인" })
        .click();
      await expect(
        page.getByRole("alert").filter({ hasText: "긴 안내 내용을 끝까지" }),
      ).toContainText(longMessage);
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight),
      ).toBeGreaterThan(viewport.height);
      const lastLink = page.getByRole("link", { name: "이용약관" });
      await lastLink.scrollIntoViewIfNeeded();
      await expect(lastLink).toBeInViewport();
    }
  });

  test("keeps the narrow login page usable with a larger browser default font", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    const session = await page.context().newCDPSession(page);
    await session.send("Page.setFontSizes", { fontSizes: { standard: 20 } });
    await page.goto("/login");

    await expect(page.locator("html")).toHaveCSS("font-size", "20px");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(320);
  });

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

  test("keeps the mobile login form usable without the desktop brand panel", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "로그인" })).toBeVisible();
    await expect(page.getByTestId("auth-brand-panel")).toBeHidden();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await expect(page.getByLabel("이메일")).toHaveCSS("height", "48px");
    await expect(
      page.getByRole("button", { name: "로그인", exact: true }),
    ).toHaveCSS("height", "44px");
  });

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

  test("renders signup and password-reset entry screens on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/auth/password-reset/request", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        status: 202,
        json: { status: "accepted" },
      });
    });
    await page.route("**/api/auth/password-reset/resend", async (route) => {
      await route.fulfill({
        status: 429,
        headers: { "retry-after": "60" },
        json: { code: "rate_limit_exceeded" },
      });
    });

    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: "회원가입" })).toBeVisible();
    await expect(
      page.getByLabel("비밀번호 확인", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "인증 요청" })).toBeVisible();

    await page.goto("/forgot-password");
    await expect(
      page.getByRole("heading", { name: "비밀번호 재설정" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "재설정 메일 보내기" }),
    ).toBeVisible();
    await page.getByLabel("이메일").fill("abc@gmail.com");
    await page.getByRole("button", { name: "재설정 메일 보내기" }).click();
    await expect(
      page.getByRole("img", { name: "성공", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "메일 다시 보내기" }).click();
    await expect(
      page.getByRole("img", { name: "주의", exact: true }),
    ).toBeVisible();
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

  for (const scenario of [
    {
      path: "/signup",
      endpoint: "signup/complete",
      button: "회원가입",
      success: "회원가입이 완료되었습니다!",
    },
    {
      path: "/reset-password?token=retry-reset",
      endpoint: "password-reset/confirm",
      button: "비밀번호 변경",
      success: "비밀번호를 변경했어요",
    },
    {
      path: "/login/link",
      endpoint: "link/password",
      button: "동의하고 연결",
      success: "계정 연결 완료",
    },
  ]) {
    test(`recovers ${scenario.endpoint} submission after a failed connection`, async ({
      page,
    }) => {
      await page.route("**/api/auth/password-reset/session", (route) =>
        route.fulfill({
          json: { expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
        }),
      );
      await page.route("**/api/auth/link/status", (route) =>
        route.fulfill({
          json: { email: "qa@example.com", requiredProvider: "password" },
        }),
      );
      const endpoint = `**/api/auth/${scenario.endpoint}`;
      await page.route(endpoint, (route) => route.abort("failed"));
      await page.goto(scenario.path);
      if (scenario.path === "/signup") await prepareSignup(page);
      const password = page.getByLabel("비밀번호", { exact: true });
      await password.fill("ValidPass1234");
      const confirmation = page.getByLabel("비밀번호 확인", { exact: true });
      if (await confirmation.count()) await confirmation.fill("ValidPass1234");
      const submit = page.getByRole("button", {
        name: scenario.button,
        exact: true,
      });
      await submit.click();
      await expect(
        page.getByRole("alert").filter({ hasText: "다시 시도해주세요" }),
      ).toBeVisible();
      await expect(submit).toBeEnabled();
      await expect(password).toHaveValue("ValidPass1234");
      await page.unroute(endpoint);
      let releaseRetry = () => {};
      const pendingRetry = new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      await page.route(endpoint, async (route) => {
        await pendingRetry;
        await route.fulfill(
          scenario.endpoint === "link/password"
            ? {
                status: 200,
                json: {
                  id: "0e448f42-4699-4ca2-8190-720133a4dfd2",
                  email: "qa@example.com",
                  emailVerified: true,
                },
              }
            : scenario.endpoint === "signup/complete"
              ? { json: { status: "created" } }
              : { status: 204 },
        );
      });
      await submit.click();
      try {
        await expect(page.locator("button[type=submit]")).toBeDisabled();
        await expect(
          page.getByRole("alert").filter({
            hasText: "요청을 처리하지 못했습니다. 다시 시도해주세요.",
          }),
        ).toHaveCount(0);
      } finally {
        releaseRetry();
      }
      await expect(
        page.getByText(scenario.success, { exact: true }).first(),
      ).toBeVisible();
      expect(
        await page
          .getByRole("alert")
          .filter({ hasText: "요청을 처리하지 못했습니다. 다시 시도해주세요." })
          .count(),
      ).toBe(0);
    });
  }

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
