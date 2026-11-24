import {
  CreateOrderRequestSchema,
  DonorCandidatesQuerySchema,
  DonorCandidatesResponseSchema,
  ErrorBodySchema,
  OrderCancelBodySchema,
  OrderCommitBodySchema,
  OrderDeclineBodySchema,
  OrderListQuerySchema,
  OrderListResponseSchema,
  OrderReceiveBodySchema,
  OrderRequestTransferBodySchema,
  OrderRerouteBodySchema,
  ReplenishmentOrderSchema,
} from "@stockflow/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../plugins/auth.js";
import {
  DecisionConflictError,
  DecisionForbiddenError,
  OrderConflictError,
  OrderNotFoundError,
  OrderValidationError,
  type StockServices,
} from "../services/index.js";
import {
  LifecycleOrderListResponseSchema,
  LifecycleOrderSchema,
  QueueLifecycleViewSchema,
} from "../services/queueLifecycle.js";

const PathIdSchema = z.object({ id: z.string().min(1) });
const ExtendedOrderListQuerySchema = OrderListQuerySchema.merge(
  z.object({ view: QueueLifecycleViewSchema.optional() }),
);
const OrderReopenBodySchema = z.object({
  comment: z.string().max(500).optional(),
});

function cleanQuery(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== "" && value !== undefined && value !== null) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function sendOrderError(err: unknown, reply: FastifyReply): unknown {
  if (err instanceof OrderNotFoundError) {
    return reply.code(404).send(ErrorBodySchema.parse({ error: err.message }));
  }
  if (err instanceof DecisionForbiddenError) {
    return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
  }
  if (err instanceof OrderConflictError || err instanceof DecisionConflictError) {
    return reply.code(409).send(ErrorBodySchema.parse({ error: err.message }));
  }
  if (err instanceof OrderValidationError) {
    return reply.code(400).send(ErrorBodySchema.parse({ error: err.message }));
  }
  throw err;
}

export function registerOrderRoutes(
  app: FastifyInstance,
  services: StockServices,
  authGuards: AuthContext,
): void {
  // Register before /orders/:id so "donor-candidates" never binds as an order id.
  // RBAC: Admin and manager (recommendations:decide; finds eligible transfer donors).
  app.get(
    "/orders/donor-candidates",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      const parsed = DonorCandidatesQuerySchema.safeParse(cleanQuery(request.query));
      if (!parsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: parsed.error.issues[0]?.message || "Invalid donor candidates query",
          }),
        );
      }
      try {
        const candidates = await services.orders.donorCandidates(
          parsed.data.sku,
          parsed.data.target,
          parsed.data.qty,
          request.currentUser,
          {
            includeIneligible: parsed.data.includeIneligible,
            limit: parsed.data.limit,
          },
        );
        return DonorCandidatesResponseSchema.parse({ candidates });
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin, manager, staff (recommendations:read; non-admin filtered to assigned branch orders).
  app.get(
    "/orders",
    { preHandler: [authGuards.requirePermission("recommendations:read")] },
    async (request, reply) => {
      const parsed = ExtendedOrderListQuerySchema.safeParse(cleanQuery(request.query));
      if (!parsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: parsed.error.issues[0]?.message || "Invalid order list query",
          }),
        );
      }
      try {
        const res = await services.orders.list(parsed.data, request.currentUser);
        if (parsed.data.view) {
          return LifecycleOrderListResponseSchema.parse(res);
        }
        return OrderListResponseSchema.parse(res);
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin and manager (recommendations:decide; enforces targetBranchId scope inside service).
  app.post(
    "/orders",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      const parsed = CreateOrderRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: parsed.error.issues[0]?.message || "Invalid create order request",
          }),
        );
      }
      try {
        const created = await services.orders.create(parsed.data, request.currentUser);
        return reply.code(201).send(ReplenishmentOrderSchema.parse(created));
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin, manager, staff (recommendations:read; 404 when order branches fall outside user scope).
  app.get(
    "/orders/:id",
    { preHandler: [authGuards.requirePermission("recommendations:read")] },
    async (request, reply) => {
      const pathParsed = PathIdSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid order ID" }));
      }
      try {
        const order = await services.orders.get(pathParsed.data.id, request.currentUser);
        return ReplenishmentOrderSchema.parse(order);
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin and manager (recommendations:decide; receiver manager or admin opens donor approval).
  app.post(
    "/orders/:id/request",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      const pathParsed = PathIdSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid order ID" }));
      }
      const bodyParsed = OrderRequestTransferBodySchema.safeParse(request.body ?? {});
      if (!bodyParsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: bodyParsed.error.issues[0]?.message || "Invalid transfer request input",
          }),
        );
      }
      try {
        const updated = await services.orders.requestTransfer(
          pathParsed.data.id,
          bodyParsed.data,
          request.currentUser,
        );
        return ReplenishmentOrderSchema.parse(updated);
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin and manager (recommendations:decide; donor branch manager sends or admin overrides with force+comment).
  app.post(
    "/orders/:id/commit",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      const pathParsed = PathIdSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid order ID" }));
      }
      const bodyParsed = OrderCommitBodySchema.safeParse(request.body ?? {});
      if (!bodyParsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: bodyParsed.error.issues[0]?.message || "Invalid commit input",
          }),
        );
      }
      try {
        const updated = await services.orders.commit(
          pathParsed.data.id,
          bodyParsed.data,
          request.currentUser,
        );
        return ReplenishmentOrderSchema.parse(updated);
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin and manager (recommendations:decide; donor declines incoming transfer or receiver rejects suggestion).
  app.post(
    "/orders/:id/decline",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      const pathParsed = PathIdSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid order ID" }));
      }
      const bodyParsed = OrderDeclineBodySchema.safeParse(request.body ?? {});
      if (!bodyParsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: bodyParsed.error.issues[0]?.message || "Comment is required when declining",
          }),
        );
      }
      try {
        const updated = await services.orders.decline(
          pathParsed.data.id,
          bodyParsed.data,
          request.currentUser,
        );
        return ReplenishmentOrderSchema.parse(updated);
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin and manager (recommendations:decide; receiver or admin reassigns declined transfer to another donor).
  app.post(
    "/orders/:id/reroute",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      const pathParsed = PathIdSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid order ID" }));
      }
      const bodyParsed = OrderRerouteBodySchema.safeParse(request.body ?? {});
      if (!bodyParsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: bodyParsed.error.issues[0]?.message || "Invalid reroute input",
          }),
        );
      }
      try {
        const updated = await services.orders.reroute(
          pathParsed.data.id,
          bodyParsed.data,
          request.currentUser,
        );
        return ReplenishmentOrderSchema.parse(updated);
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin and manager (recommendations:decide; requester or admin cancels pending request before commit).
  app.post(
    "/orders/:id/cancel",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      const pathParsed = PathIdSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid order ID" }));
      }
      const bodyParsed = OrderCancelBodySchema.safeParse(request.body ?? {});
      if (!bodyParsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: bodyParsed.error.issues[0]?.message || "Invalid cancel input",
          }),
        );
      }
      try {
        const updated = await services.orders.cancel(
          pathParsed.data.id,
          bodyParsed.data,
          request.currentUser,
        );
        return ReplenishmentOrderSchema.parse(updated);
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin, manager, staff (orders:receive; receiving-branch user or admin marks order DELIVERED).
  app.post(
    "/orders/:id/receive",
    { preHandler: [authGuards.requirePermission("orders:receive")] },
    async (request, reply) => {
      const pathParsed = PathIdSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid order ID" }));
      }
      const bodyParsed = OrderReceiveBodySchema.safeParse(request.body ?? {});
      if (!bodyParsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: bodyParsed.error.issues[0]?.message || "Invalid receive input",
          }),
        );
      }
      try {
        const updated = await services.orders.receive(
          pathParsed.data.id,
          bodyParsed.data,
          request.currentUser,
        );
        return ReplenishmentOrderSchema.parse(updated);
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin and manager (recommendations:decide; reopens recent decision within 24h window and user scope).
  app.post(
    "/orders/:id/reopen",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      const pathParsed = PathIdSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid order ID" }));
      }
      const bodyParsed = OrderReopenBodySchema.safeParse(request.body ?? {});
      if (!bodyParsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: bodyParsed.error.issues[0]?.message || "Invalid reopen input",
          }),
        );
      }
      try {
        const updated = await services.orders.reopen(
          pathParsed.data.id,
          request.currentUser,
          bodyParsed.data.comment,
        );
        return LifecycleOrderSchema.parse(updated);
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );
}
