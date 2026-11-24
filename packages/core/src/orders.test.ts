import { describe, expect, it } from "vitest";
import {
  ORDER_TRANSITION_TABLE,
  OrderStatusSchema,
  OrderTransitionActionSchema,
  canTransition,
  type OrderOwnership,
  type OrderStatus,
  type OrderType,
} from "./orders.js";
import type { Role } from "./schemas/auth.js";

function orderOf(
  status: OrderStatus,
  type: OrderType = "TRANSFER",
  sourceBranchId: string | null = "BR-005",
) {
  return {
    status,
    type,
    targetBranchId: "BR-001",
    sourceBranchId,
  };
}

function own(overrides: Partial<OrderOwnership> = {}): OrderOwnership {
  return {
    ownsTarget: false,
    ownsSource: false,
    intraCluster: false,
    isRequester: false,
    hasComment: false,
    force: false,
    targetDonorBranchId: undefined,
    ...overrides,
  };
}

describe("ReplenishmentOrder pure state machine & canTransition", () => {
  it("covers every status x action in ORDER_TRANSITION_TABLE", () => {
    for (const action of OrderTransitionActionSchema.options) {
      const rule = ORDER_TRANSITION_TABLE[action];
      for (const status of OrderStatusSchema.options) {
        const res = canTransition(
          orderOf(status),
          { role: "admin" },
          action,
          own({
            isRequester: true,
            hasComment: true,
            targetDonorBranchId: action === "REROUTE" ? "BR-008" : "BR-005",
          }),
        );
        if (rule.from.includes(status)) {
          expect(res.allowed, `${action} from ${status} should be allowed for admin`).toBe(true);
        } else {
          expect(res.allowed).toBe(false);
          if (!res.allowed) expect(res.code).toBe("INVALID_STATE");
        }
      }
    }
  });

  it("enforces two-party cross-cluster vs intra-cluster COMMIT rules", () => {
    // Receiver manager CANNOT commit a cross-cluster SUGGESTED or AWAITING_DONOR transfer
    expect(
      canTransition(orderOf("SUGGESTED"), { role: "manager" }, "COMMIT", own({ ownsTarget: true })),
    ).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    expect(
      canTransition(orderOf("AWAITING_DONOR"), { role: "manager" }, "COMMIT", own({ ownsTarget: true })),
    ).toMatchObject({ allowed: false, code: "FORBIDDEN" });

    // Donor manager CAN commit AWAITING_DONOR, NOT raw SUGGESTED cross-cluster unless requester first asks or intra-cluster
    expect(
      canTransition(orderOf("AWAITING_DONOR"), { role: "manager" }, "COMMIT", own({ ownsSource: true })),
    ).toEqual({ allowed: true, nextStatus: "COMMITTED", isAdminOverride: false });
    expect(
      canTransition(orderOf("SUGGESTED"), { role: "manager" }, "COMMIT", own({ ownsSource: true })),
    ).toMatchObject({ allowed: false, code: "FORBIDDEN" });

    // Intra-cluster manager CAN commit directly from SUGGESTED, OPEN_REQUEST, or AWAITING_DONOR
    expect(
      canTransition(
        orderOf("SUGGESTED"),
        { role: "manager" },
        "COMMIT",
        own({ ownsTarget: true, ownsSource: true, intraCluster: true }),
      ),
    ).toEqual({ allowed: true, nextStatus: "COMMITTED", isAdminOverride: false });

    // Non-transfer REORDER/MARKDOWN only requires target ownership
    expect(
      canTransition(orderOf("SUGGESTED", "REORDER", null), { role: "manager" }, "COMMIT", own({ ownsTarget: true })),
    ).toEqual({ allowed: true, nextStatus: "COMMITTED", isAdminOverride: false });
    expect(
      canTransition(orderOf("SUGGESTED", "REORDER", null), { role: "manager" }, "COMMIT", own({ ownsSource: true })),
    ).toMatchObject({ allowed: false, code: "FORBIDDEN" });

    // Staff cannot commit anything
    expect(
      canTransition(
        orderOf("SUGGESTED"),
        { role: "staff" },
        "COMMIT",
        own({ ownsTarget: true, ownsSource: true, intraCluster: true }),
      ),
    ).toMatchObject({ allowed: false, code: "FORBIDDEN" });
  });

  it("requires a comment for admin force-commit and for DECLINE", () => {
    // Normal engine suggestion commit by admin works without comment
    expect(
      canTransition(orderOf("SUGGESTED"), { role: "admin" }, "COMMIT", own()),
    ).toEqual({ allowed: true, nextStatus: "COMMITTED", isAdminOverride: false });

    // Explicit force:true on SUGGESTED requires comment
    expect(
      canTransition(orderOf("SUGGESTED"), { role: "admin" }, "COMMIT", own({ force: true, hasComment: false })),
    ).toMatchObject({ allowed: false, code: "VALIDATION_ERROR" });
    expect(
      canTransition(orderOf("SUGGESTED"), { role: "admin" }, "COMMIT", own({ force: true, hasComment: true })),
    ).toEqual({ allowed: true, nextStatus: "COMMITTED", isAdminOverride: true });

    // Admin force-committing AWAITING_DONOR or OPEN_REQUEST TRANSFER requires comment
    expect(
      canTransition(orderOf("AWAITING_DONOR"), { role: "admin" }, "COMMIT", own({ hasComment: false })),
    ).toMatchObject({ allowed: false, code: "VALIDATION_ERROR" });
    expect(
      canTransition(orderOf("AWAITING_DONOR"), { role: "admin" }, "COMMIT", own({ hasComment: true })),
    ).toEqual({ allowed: true, nextStatus: "COMMITTED", isAdminOverride: true });

    // DECLINE requires comment AND donor manager or admin
    expect(
      canTransition(orderOf("AWAITING_DONOR"), { role: "manager" }, "DECLINE", own({ ownsTarget: true, hasComment: true })),
    ).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    expect(
      canTransition(orderOf("AWAITING_DONOR"), { role: "manager" }, "DECLINE", own({ ownsSource: true, hasComment: false })),
    ).toMatchObject({ allowed: false, code: "VALIDATION_ERROR" });
    expect(
      canTransition(orderOf("AWAITING_DONOR"), { role: "manager" }, "DECLINE", own({ ownsSource: true, hasComment: true })),
    ).toEqual({ allowed: true, nextStatus: "REJECTED", isAdminOverride: false });
  });

  it("enforces REQUEST_TRANSFER, REROUTE, CANCEL, and RECEIVE role/state boundaries", () => {
    // REQUEST_TRANSFER: target manager or admin only, valid donor distinct from target
    expect(
      canTransition(
        orderOf("SUGGESTED"),
        { role: "manager" },
        "REQUEST_TRANSFER",
        own({ ownsSource: true }),
      ),
    ).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    expect(
      canTransition(
        orderOf("OPEN_REQUEST", "TRANSFER", null),
        { role: "manager" },
        "REQUEST_TRANSFER",
        own({ ownsTarget: true, targetDonorBranchId: "BR-001" }),
      ),
    ).toMatchObject({ allowed: false, code: "VALIDATION_ERROR" });
    expect(
      canTransition(
        orderOf("OPEN_REQUEST", "TRANSFER", null),
        { role: "manager" },
        "REQUEST_TRANSFER",
        own({ ownsTarget: true, targetDonorBranchId: "BR-005" }),
      ),
    ).toEqual({ allowed: true, nextStatus: "AWAITING_DONOR", isAdminOverride: false });

    // REROUTE: target manager or admin only, donor must differ from current source and target
    expect(
      canTransition(
        orderOf("AWAITING_DONOR", "TRANSFER", "BR-005"),
        { role: "manager" },
        "REROUTE",
        own({ ownsSource: true, targetDonorBranchId: "BR-008" }),
      ),
    ).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    expect(
      canTransition(
        orderOf("REJECTED", "TRANSFER", "BR-005"),
        { role: "manager" },
        "REROUTE",
        own({ ownsTarget: true, targetDonorBranchId: "BR-005" }),
      ),
    ).toMatchObject({ allowed: false, code: "VALIDATION_ERROR" });
    expect(
      canTransition(
        orderOf("REJECTED", "TRANSFER", "BR-005"),
        { role: "manager" },
        "REROUTE",
        own({ ownsTarget: true, targetDonorBranchId: "BR-008" }),
      ),
    ).toEqual({ allowed: true, nextStatus: "AWAITING_DONOR", isAdminOverride: false });

    // CANCEL: requester only, never after COMMITTED
    expect(
      canTransition(orderOf("AWAITING_DONOR"), { role: "admin" }, "CANCEL", own({ isRequester: false })),
    ).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    expect(
      canTransition(orderOf("AWAITING_DONOR"), { role: "manager" }, "CANCEL", own({ isRequester: true })),
    ).toEqual({ allowed: true, nextStatus: "CANCELLED", isAdminOverride: false });
    expect(
      canTransition(orderOf("COMMITTED"), { role: "manager" }, "CANCEL", own({ isRequester: true })),
    ).toMatchObject({ allowed: false, code: "INVALID_STATE" });

    // RECEIVE: COMMITTED only, target manager/staff or admin; never donor-only or out-of-scope staff
    const receiveRoles: Array<{ role: Role; ownership: OrderOwnership; ok: boolean }> = [
      { role: "staff", ownership: own({ ownsTarget: true }), ok: true },
      { role: "manager", ownership: own({ ownsTarget: true }), ok: true },
      { role: "admin", ownership: own({}), ok: true },
      { role: "staff", ownership: own({ ownsSource: true }), ok: false },
      { role: "manager", ownership: own({ ownsSource: true }), ok: false },
    ];
    for (const r of receiveRoles) {
      const res = canTransition(orderOf("COMMITTED"), { role: r.role }, "RECEIVE", r.ownership);
      expect(res.allowed).toBe(r.ok);
    }
    expect(
      canTransition(orderOf("AWAITING_DONOR"), { role: "staff" }, "RECEIVE", own({ ownsTarget: true })),
    ).toMatchObject({ allowed: false, code: "INVALID_STATE" });
  });
});
