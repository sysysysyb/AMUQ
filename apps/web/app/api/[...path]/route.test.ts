import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const originalApiOrigin = process.env.API_ORIGIN;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiOrigin === undefined) {
    delete process.env.API_ORIGIN;
  } else {
    process.env.API_ORIGIN = originalApiOrigin;
  }
});

describe("same-origin API proxy", () => {
  it("forwards the path, query, and one generated request ID", async () => {
    process.env.API_ORIGIN = "https://api.example.test/base/";
    const upstream = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const requestId = headers.get("x-request-id");

        expect(requestId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );

        return Response.json(
          { status: "ok" },
          { headers: { "x-request-id": requestId ?? "" } },
        );
      },
    );
    vi.stubGlobal("fetch", upstream);

    const response = await GET(
      new Request("http://web.example.test/api/health?probe=1", {
        headers: { "x-request-id": "browser-controlled" },
      }),
      { params: Promise.resolve({ path: ["health"] }) },
    );

    expect(upstream).toHaveBeenCalledOnce();
    expect(String(upstream.mock.calls[0]?.[0])).toBe(
      "https://api.example.test/base/health?probe=1",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).not.toBe("browser-controlled");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("streams request bodies and keeps one gateway request ID", async () => {
    process.env.API_ORIGIN = "https://api.example.test";
    let forwardedRequestId: string | null = null;
    const upstream = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        forwardedRequestId = new Headers(init?.headers).get("x-request-id");
        expect((init as RequestInit & { duplex?: "half" }).duplex).toBe("half");
        expect(await new Response(init?.body).text()).toBe('{"answer":42}');

        return Response.json(
          { accepted: true },
          {
            status: 202,
            headers: { "x-request-id": "upstream-other" },
          },
        );
      },
    );
    vi.stubGlobal("fetch", upstream);

    const response = await POST(
      new Request("http://web.example.test/api/answers", {
        method: "POST",
        body: JSON.stringify({ answer: 42 }),
      }),
      { params: Promise.resolve({ path: ["answers"] }) },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("x-request-id")).toBe(forwardedRequestId);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it("strips hop-by-hop and decoded representation headers", async () => {
    process.env.API_ORIGIN = "https://api.example.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { status: "ok" },
          {
            headers: {
              connection: "x-hop",
              "content-encoding": "gzip",
              "content-length": "999",
              "x-hop": "leak",
            },
          },
        ),
      ),
    );

    const response = await GET(
      new Request("http://web.example.test/api/health"),
      { params: Promise.resolve({ path: ["health"] }) },
    );

    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-hop")).toBeNull();
  });

  it("passes cancellation upstream and returns a bounded timeout", async () => {
    process.env.API_ORIGIN = "https://api.example.test";
    const controller = new AbortController();
    const observed = { signal: null as AbortSignal | null };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(
          async (_input: string | URL | Request, init?: RequestInit) => {
            observed.signal = init?.signal ?? null;
            return Response.json({ status: "ok" });
          },
        )
        .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError")),
    );

    await GET(
      new Request("http://web.example.test/api/health", {
        signal: controller.signal,
      }),
      { params: Promise.resolve({ path: ["health"] }) },
    );
    controller.abort();
    expect(observed.signal?.aborted).toBe(true);

    const timeout = await GET(
      new Request("http://web.example.test/api/health"),
      { params: Promise.resolve({ path: ["health"] }) },
    );
    expect(timeout.status).toBe(504);
    expect(timeout.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(timeout.headers.get("cache-control")).toBe("no-store");
  });
});
