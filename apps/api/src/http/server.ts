import { randomUUID } from "node:crypto";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type RawRequestDefaultExpression } from "fastify";

type Environment = "development" | "production" | "test";

export interface BuildServerOptions {
  environment?: Environment;
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requestId(request: RawRequestDefaultExpression): string {
  const header = request.headers["x-request-id"];
  return typeof header === "string" && requestIdPattern.test(header)
    ? header
    : randomUUID();
}

function statusSchema(status: "ok" | "ready") {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: { type: "string", const: status },
    },
  } as const;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const environment = options.environment ?? "development";
  const server = Fastify({
    genReqId: requestId,
    logger: environment !== "test",
  });

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
    reply.header("x-request-id", request.id);
  });

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
        response: { 200: statusSchema("ready") },
      },
    },
    async () => ({ status: "ready" }),
  );

  server.get("/openapi.json", { schema: { hide: true } }, async () =>
    server.swagger(),
  );

  await server.ready();
  return server;
}
