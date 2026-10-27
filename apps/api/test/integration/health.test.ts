import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer, registerShutdownHandlers } from "#api/http/server";

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const createServer = async (
  environment: "development" | "production" | "test",
) => {
  const server = await buildServer({ environment });
  servers.push(server);
  return server;
};

describe("HTTP foundation", () => {
  it.each(["production", "development"])(
    "keeps private input out of %s request logs while preserving error diagnostics",
    (environment) => {
      const result = spawnSync(
        process.execPath,
        [
          "--conditions=development",
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `import { PassThrough } from "node:stream";
         import { buildServer } from "#api/http/server";
         const server = await buildServer({ environment: "${environment}" });
         server.get("/auth/google/callback", async () => ({ status: "ok" }));
         server.get("/failure", async () => {
           throw Object.assign(new Error("private-error-fixture"), {
             code: "private-error-code-fixture",
             detail: "private-error-detail-fixture",
             cause: new Error("private-error-cause-fixture"),
           });
         });
         server.get("/serializer-failure", {
           schema: { response: { 500: {
             type: "object", required: ["missing"], properties: { missing: { type: "string" } },
           } } },
         }, async () => { throw new Error("private-serializer-fixture"); });
         server.get("/stream-failure", async (_request, reply) => {
           const stream = new PassThrough();
           reply.send(stream);
           stream.write("started");
           setImmediate(() => stream.destroy(new Error("private-stream-fixture")));
           return reply;
         });
         server.post("/json", async () => ({ status: "ok" }));
         server.get("/double-send", async (_request, reply) => {
           reply.send({ status: "ok" });
           reply.send({ status: "duplicate" });
           return reply;
         });
         server.get("/bare-error", async (request) => {
           request.log.error(new Error("private-bare-error-fixture"));
           return { status: "ok" };
         });
         server.get("/client-failure", async () => {
           throw Object.assign(new Error("private-client-error-fixture"), {
             statusCode: 400, code: "private-client-code-fixture",
           });
         });
         server.get("/header-failure", async (_request, reply) => {
           const writeHead = reply.raw.writeHead.bind(reply.raw);
           let attempts = 0;
           reply.raw.writeHead = (...args) => {
             if (++attempts <= 3) {
               throw Object.assign(new Error("private-write-head-fixture"), {
                 code: "ERR_HTTP_HEADERS_SENT",
               });
             }
             return writeHead(...args);
           };
           return { status: "ok" };
         });
         try {
           for (const path of ["/auth/google/callback", "/missing/private-path-fixture", "/failure", "/serializer-failure", "/documentation/", "/double-send", "/client-failure", "/header-failure", "/bare-error"]) {
             await server.inject({
               method: "GET",
               url: path + "?code=private-code-fixture&state=private-state-fixture&email=private-email-fixture",
               headers: {
                 cookie: "__Host-session=private-cookie-fixture",
                 authorization: "Bearer private-header-fixture",
               },
             });
           }
           await server.inject({
             method: "POST", url: "/json",
             headers: { "content-type": "application/json" },
             payload: '{"email":"private-body-fixture",invalid}',
           });
           await server.inject({ url: "/stream-failure?token=private-stream-token-fixture" }).catch(() => undefined);
         } finally {
           await server.close();
         }`,
        ],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          encoding: "utf8",
          timeout: 10_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("private-");
      const logs = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const duplicateRequest = logs.find(
        (log) => log.req?.route === "/double-send",
      );
      expect(duplicateRequest).toBeDefined();
      expect(logs).toContainEqual(
        expect.objectContaining({
          reqId: duplicateRequest.reqId,
          level: 40,
          err: "[Redacted]",
          msg: "FST_ERR_REP_ALREADY_SENT",
        }),
      );
      const bareErrorRequest = logs.find(
        (log) => log.req?.route === "/bare-error",
      );
      expect(bareErrorRequest).toBeDefined();
      expect(logs).toContainEqual(
        expect.objectContaining({
          reqId: bareErrorRequest.reqId,
          level: 50,
          err: "[Redacted]",
          msg: "server error",
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          reqId: expect.any(String),
          req: { method: "GET", route: "/auth/google/callback" },
        }),
      );
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reqId: expect.any(String),
            res: expect.objectContaining({ statusCode: 200 }),
            responseTime: expect.any(Number),
          }),
          expect.objectContaining({
            reqId: expect.any(String),
            res: expect.objectContaining({ statusCode: 404 }),
            responseTime: expect.any(Number),
          }),
          expect.objectContaining({
            level: 50,
            reqId: expect.any(String),
            req: { method: "GET", route: "/failure" },
            res: expect.objectContaining({ statusCode: 500 }),
            errorCode: "INTERNAL_ERROR",
            msg: "request failed",
          }),
          expect.objectContaining({
            reqId: expect.any(String),
            errorCode: "FST_ERR_CTP_INVALID_JSON_BODY",
            res: expect.objectContaining({ statusCode: 400 }),
          }),
          expect.objectContaining({
            level: 50,
            reqId: expect.any(String),
            statusCode: 500,
            err: "[Redacted]",
            msg: "The serializer for the given status code failed",
          }),
          expect.objectContaining({
            level: 40,
            reqId: expect.any(String),
            err: "[Redacted]",
            msg: "response terminated with an error with headers already sent",
          }),
          expect.objectContaining({
            reqId: expect.any(String),
            errorCode: "REQUEST_ERROR",
            req: { method: "GET", route: "/client-failure" },
            res: expect.objectContaining({ statusCode: 400 }),
          }),
          expect.objectContaining({
            level: 40,
            reqId: expect.any(String),
            req: { method: "GET", route: "/header-failure" },
            msg: "response headers failed",
          }),
        ]),
      );
      if (environment === "development") {
        const documentationRequest = logs.find(
          (log) => log.req?.route === "/documentation",
        );
        expect(documentationRequest).toBeDefined();
        expect(logs).toContainEqual(
          expect.objectContaining({
            res: expect.objectContaining({ statusCode: 200 }),
            responseTime: expect.any(Number),
            reqId: documentationRequest.reqId,
            msg: "request completed",
          }),
        );
      }
    },
  );

  it("uses only the authenticated proxy client address", async () => {
    const server = await buildServer({
      environment: "test",
      proxySecret: "server-secret",
    });
    servers.push(server);
    server.get("/client-address", async (request) => ({
      clientAddress: request.clientAddress,
      host: request.host,
      ip: request.ip,
      protocol: request.protocol,
    }));

    const authenticated = await server.inject({
      method: "GET",
      url: "/client-address",
      remoteAddress: "10.1.2.3",
      headers: {
        host: "internal.test",
        "x-amuq-client-address": "203.0.113.7",
        "x-amuq-proxy-secret": "server-secret",
        "x-forwarded-for": "203.0.113.7, 10.9.8.7",
        "x-forwarded-host": "api.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const spoofed = await server.inject({
      method: "GET",
      url: "/client-address",
      remoteAddress: "198.51.100.8",
      headers: {
        forwarded: "for=203.0.113.9;proto=https;host=evil.example",
        host: "direct.example.test",
        "x-amuq-client-address": "203.0.113.9",
        "x-amuq-proxy-secret": "attacker-controlled",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    const malformed = await server.inject({
      method: "GET",
      url: "/client-address",
      remoteAddress: "192.0.2.8",
      headers: {
        "x-amuq-client-address": "not-an-ip",
        "x-amuq-proxy-secret": "server-secret",
      },
    });

    expect(authenticated.json()).toEqual({
      clientAddress: "203.0.113.7",
      host: "internal.test",
      ip: "10.1.2.3",
      protocol: "http",
    });
    expect(spoofed.json()).toEqual({
      clientAddress: "198.51.100.8",
      host: "direct.example.test",
      ip: "198.51.100.8",
      protocol: "http",
    });
    expect(malformed.json()).toMatchObject({ clientAddress: "192.0.2.8" });
  });

  it("reports liveness and readiness with one request ID", async () => {
    const server = await createServer("test");

    const health = await server.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "req-health-1" },
    });
    const ready = await server.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(health.headers["x-request-id"]).toBe("req-health-1");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
    expect(ready.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("reports unavailable when the database readiness check fails", async () => {
    const server = await buildServer({
      environment: "test",
      readiness: async () => {
        throw new Error("database unavailable");
      },
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
  });

  it("closes the database pool with the server", async () => {
    const onClose = vi.fn(async () => undefined);
    const server = await buildServer({ environment: "test", onClose });

    await server.close();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes the server once when shutdown signals repeat", async () => {
    const runtime = Object.assign(new EventEmitter(), { exitCode: undefined });
    const close = vi.fn(async () => undefined);
    const error = vi.fn();

    registerShutdownHandlers({ close, log: { error } }, runtime);
    runtime.emit("SIGTERM");
    runtime.emit("SIGINT");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    expect(error).not.toHaveBeenCalled();
  });

  it("marks a failed shutdown for a non-zero exit", async () => {
    const runtime = Object.assign(new EventEmitter(), { exitCode: undefined });
    const shutdownError = new Error("close failed");
    const error = vi.fn();

    registerShutdownHandlers(
      { close: async () => Promise.reject(shutdownError), log: { error } },
      runtime,
    );
    runtime.emit("SIGTERM");
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        { shutdownFailure: "unexpected" },
        "Server shutdown failed",
      ),
    );

    expect(runtime.exitCode).toBe(1);
  });

  it("replaces an unsafe request ID before logging or returning it", async () => {
    const server = await createServer("test");
    const unsafeRequestId = "x".repeat(129);

    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": unsafeRequestId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).not.toBe(unsafeRequestId);
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates OpenAPI from the health route schemas", async () => {
    const server = await createServer("test");
    const response = await server.inject({
      method: "GET",
      url: "/openapi.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      openapi: "3.0.3",
      info: { title: "AMUQ API", version: "0.1.0" },
      paths: {
        "/health": {
          get: {
            operationId: "getHealth",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      properties: { status: { enum: ["ok"] } },
                    },
                  },
                },
              },
            },
          },
        },
        "/ready": {
          get: {
            operationId: "getReadiness",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      properties: { status: { enum: ["ready"] } },
                    },
                  },
                },
              },
              "503": {
                content: {
                  "application/json": {
                    schema: {
                      properties: { status: { enum: ["not_ready"] } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it("serves Swagger UI only in development", async () => {
    const development = await createServer("development");
    const production = await createServer("production");

    const developmentResponse = await development.inject({
      method: "GET",
      url: "/documentation/",
    });
    const productionResponse = await production.inject({
      method: "GET",
      url: "/documentation/",
    });

    expect(developmentResponse.statusCode).toBe(200);
    expect(developmentResponse.headers["content-type"]).toContain("text/html");
    expect(productionResponse.statusCode).toBe(404);
  });
});
