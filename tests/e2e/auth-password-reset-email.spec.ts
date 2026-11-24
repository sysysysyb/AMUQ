import { expect, test } from "@playwright/test";

test.describe("authentication screens", () => {
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
});
