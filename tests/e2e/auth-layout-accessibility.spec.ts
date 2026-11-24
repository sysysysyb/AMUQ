import { expect, test } from "@playwright/test";

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
});
