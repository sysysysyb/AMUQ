import { randomUUID } from "node:crypto";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type RawRequestDefaultExpression } from "fastify";

import type { ApplicationEnvironment } from "#api/config/environment";
import { resolveClientAddress } from "./client-address.ts";

export interface BuildServerOptions {
  environment?: ApplicationEnvironment;
  onClose?: () => Promise<void>;
  proxySecret?: string;
  readiness?: () => Promise<void>;
}

interface ShutdownRuntime {
  exitCode: string | number | null | undefined;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

interface ShutdownServer {
  close(): Promise<unknown>;
  log: { error(error: unknown): unknown };
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requestId(request: RawRequestDefaultExpression): string {
  const header = request.headers["x-request-id"];
  return typeof header === "string" && requestIdPattern.test(header)
    ? header
    : randomUUID();
}

function statusSchema(status: "not_ready" | "ok" | "ready") {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: { type: "string", const: status },
    },
  } as const;
}

export function registerShutdownHandlers(
  server: ShutdownServer,
  runtime: ShutdownRuntime = process,
): void {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void server.close().catch((error: unknown) => {
      server.log.error(error);
      runtime.exitCode = 1;
    });
  };

  runtime.once("SIGINT", close);
  runtime.once("SIGTERM", close);
}

export async function buildServer(options: BuildServerOptions = {}) {
  const environment = options.environment ?? "development";
  const readiness = options.readiness ?? (async () => undefined);
  const server = Fastify({
    genReqId: requestId,
    logger: environment !== "test",
    trustProxy: false,
  });

  server.decorateRequest("clientAddress", "");

  await server.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "AMUQ API",
        version: "0.1.0",
      },
    },
  });

  if (environment === "development") {
    await server.register(swaggerUi, { routePrefix: "/documentation" });
  }

  server.addHook("onRequest", async (request, reply) => {
    request.clientAddress = resolveClientAddress(request, options.proxySecret);
    reply.header("x-request-id", request.id);
  });

  if (options.onClose) {
    server.addHook("onClose", options.onClose);
  }

  server.get(
    "/health",
    {
      schema: {
        operationId: "getHealth",
        response: { 200: statusSchema("ok") },
      },
    },
    async () => ({ status: "ok" }),
  );

  server.get(
    "/ready",
    {
      schema: {
        operationId: "getReadiness",
        response: {
          200: statusSchema("ready"),
          503: statusSchema("not_ready"),
        },
      },
    },
    async (_request, reply) => {
      try {
        await readiness();
        return { status: "ready" };
      } catch {
        return reply.code(503).send({ status: "not_ready" });
      }
    },
  );

  server.get("/openapi.json", { schema: { hide: true } }, async () =>
    server.swagger(),
  );

  return server;
}
