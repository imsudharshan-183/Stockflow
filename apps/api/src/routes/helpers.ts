import { ErrorBodySchema } from "@stockflow/core";
import type { FastifyReply } from "fastify";
import {
  BranchConflictError,
  BranchNotFoundError,
  BranchValidationError,
  DecisionForbiddenError,
  ProductConflictError,
  ProductNotFoundError,
  ProductValidationError,
  StockAlertConflictError,
  StockAlertNotFoundError,
  StockAlertValidationError,
} from "../services/index.js";

/** Strips empty-string / nullish query values so Zod optional parameters parse cleanly. */
export function cleanQuery(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== "" && value !== undefined && value !== null) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function sendApiError(reply: FastifyReply, statusCode: number, error: string): unknown {
  return reply.code(statusCode).send(ErrorBodySchema.parse({ error }));
}

export function handleDomainRouteError(err: unknown, reply: FastifyReply): unknown {
  if (err instanceof DecisionForbiddenError) {
    return sendApiError(reply, 403, err.message);
  }
  if (
    err instanceof BranchNotFoundError ||
    err instanceof ProductNotFoundError ||
    err instanceof StockAlertNotFoundError
  ) {
    return sendApiError(reply, 404, err.message);
  }
  if (err instanceof BranchConflictError || err instanceof ProductConflictError || err instanceof StockAlertConflictError) {
    return sendApiError(reply, 409, err.message);
  }
  if (err instanceof BranchValidationError || err instanceof ProductValidationError || err instanceof StockAlertValidationError) {
    return sendApiError(reply, 400, err.message);
  }
  throw err;
}
