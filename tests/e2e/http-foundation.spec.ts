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
  const response = await request.get("http://127.0.0.1:3001/documentation/");

  expect(response.status()).toBe(404);
});
