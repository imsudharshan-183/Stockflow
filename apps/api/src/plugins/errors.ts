import { ErrorBodySchema } from "@stockflow/core";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { redactSecrets } from "../config/redact.js";

export function registerErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const logged = error instanceof Error ? error.message : "request failed";
    request.log.error(redactSecrets(logged));
    if (error instanceof ZodError) {
      return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid request" }));
    }
    const statusCode = statusOf(error);
    const status = statusCode !== undefined && statusCode >= 400 ? statusCode : 500;
    const message = status >= 500 ? "Internal error" : "Invalid request";
    return reply.code(status).send(ErrorBodySchema.parse({ error: message }));
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send(ErrorBodySchema.parse({ error: "Not found" }));
  });
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}
