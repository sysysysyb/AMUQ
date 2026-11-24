import { expect, test } from "@playwright/test";

import { prepareSignup } from "./support/signup-email-ui";

test.describe("authentication screens", () => {
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
});
