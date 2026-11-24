import { expect, test } from "@playwright/test";

import { prepareSignup } from "./support/signup-email-ui";

test.describe("authentication screens", () => {
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
});
