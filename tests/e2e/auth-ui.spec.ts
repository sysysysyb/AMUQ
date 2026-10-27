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

  for (const width of [1440, 390, 320]) {
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
  }

  for (const scenario of [
    { provider: "password", moveFocus: false },
    { provider: "google", moveFocus: false },
    { provider: "password", moveFocus: true },
  ]) {
  }

  for (const scenario of [
    { name: "another failure", invalid: false },
    { name: "expired proof", invalid: true },
  ]) {
  }
});
