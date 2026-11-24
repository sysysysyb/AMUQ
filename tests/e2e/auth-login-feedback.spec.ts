import { expect, test } from "@playwright/test";

test.describe("authentication screens", () => {
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
});
