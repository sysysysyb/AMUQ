import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    clientAddress: string;
  }
}

export const clientAddressHeader = "x-amuq-client-address";
export const proxySecretHeader = "x-amuq-proxy-secret";

const matchesSecret = (value: string, secret: string): boolean => {
  const actual = Buffer.from(value);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const resolveClientAddress = (
  request: Pick<FastifyRequest, "headers" | "ip">,
  proxySecret?: string,
): string => {
  const address = request.headers[clientAddressHeader];
  const presentedSecret = request.headers[proxySecretHeader];
  return proxySecret &&
    typeof address === "string" &&
    isIP(address) !== 0 &&
    typeof presentedSecret === "string" &&
    matchesSecret(presentedSecret, proxySecret)
    ? address
    : request.ip;
};
