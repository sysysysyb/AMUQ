import { expect, test } from "@playwright/test";

test("the web origin reaches API health with one request ID", async ({
  request,
}) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
  expect(response.headers()["x-request-id"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("the production API entry does not expose Swagger UI by default", async ({
  request,
}) => {
  const response = await request.get(
    `${process.env.E2E_API_ORIGIN ?? "http://127.0.0.1:3001"}/documentation/`,
  );

  expect(response.status()).toBe(404);
});

test("the browser origin can submit an authentication request through the web proxy", async ({
  page,
}) => {
  await page.goto("/");

  const response = await page.evaluate(async () => {
    const result = await fetch("/api/auth/signup/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signupProof: "invalid-proof".repeat(5),
        password: "ValidPass1234",
      }),
    });
    return { body: await result.json(), status: result.status };
  });

  expect(response).toEqual({ body: { status: "invalid_proof" }, status: 400 });
});
