import {
  CreateOrderRequestSchema,
  DonorCandidatesQuerySchema,
  DonorCandidatesResponseSchema,
  ErrorBodySchema,
  LifecycleOrderListResponseSchema,
  LifecycleOrderSchema,
  OrderCancelBodySchema,
  OrderCommitBodySchema,
  OrderDeclineBodySchema,
  OrderListQuerySchema,
  OrderListResponseSchema,
  OrderReceiveBodySchema,
  OrderRequestTransferBodySchema,
  OrderRerouteBodySchema,
  QueueLifecycleViewSchema,
  ReplenishmentOrderSchema,
  StoreOrderSchema,
  isBranchInScope,
  type User,
} from "@stockflow/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";
import type { AuthContext } from "../plugins/auth.js";
import {
  DecisionConflictError,
  DecisionForbiddenError,
  OrderConflictError,
  OrderNotFoundError,
  OrderValidationError,
  type StockServices,
} from "../services/index.js";
import { cleanQuery, sendApiError } from "./helpers.js";

const PathIdSchema = z.object({ id: z.string().min(1) });
const ExtendedOrderListQuerySchema = OrderListQuerySchema.merge(
  z.object({ view: QueueLifecycleViewSchema.optional() }),
);
const OrderReopenBodySchema = z.object({
  comment: z.string().max(500).optional(),
});

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

async function runOrderAction<TBody, TResult>(
  request: FastifyRequest,
  reply: FastifyReply,
  bodySchema: ZodType<TBody>,
  invalidMessage: string,
  responseSchema: ZodType<TResult>,
  handler: (id: string, body: TBody, user: User) => Promise<unknown>,
): Promise<unknown> {
  const pathParsed = PathIdSchema.safeParse(request.params);
  if (!pathParsed.success) {
    return sendApiError(reply, 400, "Invalid order ID");
  }
  const bodyParsed = bodySchema.safeParse(request.body ?? {});
  if (!bodyParsed.success) {
    return sendApiError(reply, 400, bodyParsed.error.issues[0]?.message || invalidMessage);
  }
  try {
    const updated = await handler(pathParsed.data.id, bodyParsed.data, request.currentUser);
    return request.currentUser.role === "staff" ? StoreOrderSchema.parse(updated) : responseSchema.parse(updated);
  } catch (err) {
    return sendOrderError(err, reply);
  }
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
        const query = parsed.data;
        if (request.currentUser.role === "staff" && query.queue === "outgoing" &&
            query.status === "COMMITTED" && query.branch && !query.type && !query.sku &&
            !query.category && !query.view && services.runtime.repo.listStoreDeliveries) {
          if (!isBranchInScope(request.currentUser, query.branch)) return { orders: [], total: 0 };
          const orders = await services.runtime.repo.listStoreDeliveries(query.branch);
          return { orders, total: orders.length };
        }
        const res = await services.orders.list(parsed.data, request.currentUser);
        if (request.currentUser.role === "staff") {
          const orders = res.orders.filter((o) => query.status !== "COMMITTED" || o.type !== "MARKDOWN");
          return { orders: orders.map((order) => StoreOrderSchema.parse(order)), total: orders.length };
        }
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
        return request.currentUser.role === "staff" ? StoreOrderSchema.parse(order) : ReplenishmentOrderSchema.parse(order);
      } catch (err) {
        return sendOrderError(err, reply);
      }
    },
  );

  // RBAC: Admin and manager (recommendations:decide; receiver manager or admin opens donor approval).
  app.post(
    "/orders/:id/request",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    (request, reply) =>
      runOrderAction(
        request,
        reply,
        OrderRequestTransferBodySchema,
        "Invalid transfer request input",
        ReplenishmentOrderSchema,
        (id, body, user) => services.orders.requestTransfer(id, body, user),
      ),
  );

  // RBAC: Admin and manager (recommendations:decide; donor branch manager sends or admin overrides with force+comment).
  app.post(
    "/orders/:id/commit",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    (request, reply) =>
      runOrderAction(
        request,
        reply,
        OrderCommitBodySchema,
        "Invalid commit input",
        ReplenishmentOrderSchema,
        (id, body, user) => services.orders.commit(id, body, user),
      ),
  );

  // RBAC: Admin and manager (recommendations:decide; donor declines incoming transfer or receiver rejects suggestion).
  app.post(
    "/orders/:id/decline",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    (request, reply) =>
      runOrderAction(
        request,
        reply,
        OrderDeclineBodySchema,
        "Comment is required when declining",
        ReplenishmentOrderSchema,
        (id, body, user) => services.orders.decline(id, body, user),
      ),
  );

  // RBAC: Admin and manager (recommendations:decide; receiver or admin reassigns declined transfer to another donor).
  app.post(
    "/orders/:id/reroute",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    (request, reply) =>
      runOrderAction(
        request,
        reply,
        OrderRerouteBodySchema,
        "Invalid reroute input",
        ReplenishmentOrderSchema,
        (id, body, user) => services.orders.reroute(id, body, user),
      ),
  );

  // RBAC: Admin and manager (recommendations:decide; requester or admin cancels pending request before commit).
  app.post(
    "/orders/:id/cancel",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    (request, reply) =>
      runOrderAction(
        request,
        reply,
        OrderCancelBodySchema,
        "Invalid cancel input",
        ReplenishmentOrderSchema,
        (id, body, user) => services.orders.cancel(id, body, user),
      ),
  );

  // RBAC: Admin, manager, staff (orders:receive; receiving-branch user or admin marks order DELIVERED).
  app.post(
    "/orders/:id/receive",
    { preHandler: [authGuards.requirePermission("orders:receive")] },
    (request, reply) =>
      runOrderAction(
        request,
        reply,
        OrderReceiveBodySchema,
        "Invalid receive input",
        ReplenishmentOrderSchema,
        (id, body, user) => services.orders.receive(id, body, user),
      ),
  );

  // RBAC: Admin and manager (recommendations:decide; reopens recent decision within 24h window and user scope).
  app.post(
    "/orders/:id/reopen",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    (request, reply) =>
      runOrderAction(
        request,
        reply,
        OrderReopenBodySchema,
        "Invalid reopen input",
        LifecycleOrderSchema,
        (id, body, user) => services.orders.reopen(id, user, body.comment),
      ),
  );
}
