import { buildServer } from "./server.ts";

const server = await buildServer({
  environment: process.argv.includes("--development")
    ? "development"
    : "production",
});

await server.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3001),
});
