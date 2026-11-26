import {
  BriefRequestSchema,
  BriefResponseSchema,
  ChatRequestSchema,
  ChatResponseSchema,
} from "@stockflow/core";
import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import type { AuthContext } from "../plugins/auth.js";
import { collectBriefRecords } from "../services/briefFacts.js";
import { writeBrief } from "../services/briefWriter.js";
import { answerStockQuestion } from "../services/stockChat.js";
import { OrderNotFoundError, type StockServices } from "../services/index.js";
import { handleDomainRouteError } from "./helpers.js";

export function registerBriefRoute(
  app: FastifyInstance,
  services: StockServices,
  auth: AuthContext,
  env: Env,
) {
  const options = {
    preHandler: [
      auth.requirePermission("catalog:view"),
      app.rateLimit({
        max: 12,
        timeWindow: "1 minute",
        keyGenerator: (request) => request.currentUser.id,
      }),
    ],
  };
  app.post("/ai/chat", options, async (request, reply) => {
    if (!env.AUTH_ENABLED)
      return reply.code(403).send({ error: "Stock chat requires sign-in to be enabled" });
    const input = ChatRequestSchema.parse(request.body);
    reply.header("Cache-Control", "private, no-store");
    try {
      return ChatResponseSchema.parse(
        await answerStockQuestion(services, request.currentUser, input, env),
      );
    } catch (error) {
      return handleDomainRouteError(error, reply);
    }
  });
  app.post("/ai/brief", options, async (request, reply) => {
    if (!env.AUTH_ENABLED)
      return reply.code(403).send({ error: "Briefs require sign-in to be enabled" });
    const input = BriefRequestSchema.parse(request.body ?? {});
    try {
      const records = await collectBriefRecords(services, request.currentUser, input);
      reply.header("Cache-Control", "private, no-store");
      return BriefResponseSchema.parse(await writeBrief(records, request.currentUser.role, env));
    } catch (error) {
      if (error instanceof OrderNotFoundError)
        return reply.code(404).send({ error: "Transfer not found" });
      return handleDomainRouteError(error, reply);
    }
  });
}
