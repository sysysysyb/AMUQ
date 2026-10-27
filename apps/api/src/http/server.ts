import { randomUUID } from "node:crypto";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  LogController,
  type RawRequestDefaultExpression,
} from "fastify";
import type { ApplicationEnvironment } from "#api/config/environment";
import { resolveClientAddress } from "#api/http/client-address";

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
  log: { error(error: unknown, message?: string): unknown };
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const frameworkErrorCode = (error: unknown): string | undefined =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  Object.hasOwn(Fastify.errorCodes, error.code)
    ? error.code
    : undefined;

class RequestLogController extends LogController {
  override routeNotFound(request: FastifyRequest): void {
    request.log.info({ req: request }, "route not found");
  }

  override defaultErrorLog(
    error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const errorCode =
      frameworkErrorCode(error) ??
      (reply.statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR");
    reply.log[reply.statusCode >= 500 ? "error" : "info"](
      { req: request, res: reply, errorCode },
      "request failed",
    );
  }

  override writeHeadError(
    _error: Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    reply.log.warn({ req: request, res: reply }, "response headers failed");
  }
}

const requestId = (request: RawRequestDefaultExpression): string => {
  const header = request.headers["x-request-id"];
  return typeof header === "string" && requestIdPattern.test(header)
    ? header
    : randomUUID();
};

const statusSchema = (status: "not_ready" | "ok" | "ready") => {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: { type: "string", const: status },
    },
  } as const;
};

export const registerShutdownHandlers = (
  server: ShutdownServer,
  runtime: ShutdownRuntime = process,
): void => {
  let closing = false;
  const closeServer = async () => {
    try {
      await server.close();
    } catch {
      server.log.error(
        { shutdownFailure: "unexpected" },
        "Server shutdown failed",
      );
      runtime.exitCode = 1;
    }
  };
  const close = () => {
    if (closing) return;
    closing = true;
    void closeServer();
  };

  runtime.once("SIGINT", close);
  runtime.once("SIGTERM", close);
};

export const buildServer = async (options: BuildServerOptions = {}) => {
  const environment = options.environment ?? "development";
  const readiness = options.readiness ?? (async () => undefined);
  const server = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    genReqId: requestId,
    logController: new RequestLogController(),
    logger:
      environment === "test"
        ? false
        : {
            redact: ["err"],
            hooks: {
              logMethod(args, method) {
                const first = args[0];
                if (
                  typeof first === "string" &&
                  first.startsWith(
                    'Reply was already sent, did you forget to "return reply"',
                  )
                ) {
                  method.call(this, "response headers already sent");
                  return;
                }
                // Pino otherwise copies err.message into msg before redaction.
                if (
                  args[1] === undefined &&
                  (first instanceof Error ||
                    (typeof first === "object" &&
                      first !== null &&
                      "err" in first))
                ) {
                  const error = first instanceof Error ? first : first.err;
                  method.call(
                    this,
                    first,
                    frameworkErrorCode(error) ?? "server error",
                  );
                  return;
                }
                method.apply(this, args);
              },
            },
            serializers: {
              req: (request) => ({
                method: request.method,
                route: request.routeOptions?.url ?? null,
              }),
            },
          },
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
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "__Host-session",
          },
          passwordResetCookie: {
            type: "apiKey",
            in: "cookie",
            name: "__Host-password-reset",
          },
          accountLinkCookie: {
            type: "apiKey",
            in: "cookie",
            name: "__Host-account-link",
          },
        },
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
};
