import { randomUUID } from "node:crypto";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

type StreamingRequestInit = RequestInit & { duplex?: "half" };

const upstreamTimeoutMs = 10_000;
const hopByHopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

function stripHopByHopHeaders(headers: Headers) {
  const connectionHeaders = headers.get("connection")?.split(",") ?? [];
  for (const name of [...hopByHopHeaders, ...connectionHeaders]) {
    headers.delete(name.trim());
  }
}

function apiOrigin(): URL {
  const configured = process.env.API_ORIGIN;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("API_ORIGIN is required in production");
  }

  const origin = new URL(configured ?? "http://127.0.0.1:3001");
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("API_ORIGIN must use http or https");
  }
  return origin;
}

async function proxy(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { path } = await context.params;
  const origin = apiOrigin();
  const basePath = origin.pathname.endsWith("/")
    ? origin.pathname
    : `${origin.pathname}/`;
  origin.pathname = `${basePath}${path.map(encodeURIComponent).join("/")}`;
  origin.search = new URL(request.url).search;

  const requestId = randomUUID();
  const headers = new Headers(request.headers);
  stripHopByHopHeaders(headers);
  headers.delete("content-length");
  headers.delete("host");
  headers.set("x-request-id", requestId);

  const init: StreamingRequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.any([
      request.signal,
      AbortSignal.timeout(upstreamTimeoutMs),
    ]),
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(origin, init);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return Response.json(
        { error: "Gateway Timeout" },
        {
          status: 504,
          headers: {
            "cache-control": "no-store",
            "x-request-id": requestId,
          },
        },
      );
    }
    throw error;
  }

  const responseHeaders = new Headers(upstream.headers);
  stripHopByHopHeaders(responseHeaders);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-request-id", requestId);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
