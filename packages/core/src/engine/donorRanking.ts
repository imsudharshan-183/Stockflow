import { at, round2, round3, round4 } from "../round.js";
import type { Branch, DonorCandidate, DonorIneligibleReason, Policy } from "../schemas/index.js";
import { BAHRAIN_BRANCHES, haversineDistanceKm } from "../seed/catalog.js";
import type { Dataset } from "../seed/types.js";
import {
  assessNetwork,
  coverDaysOf,
  holdingWindowDays,
  type Position,
} from "./classify.js";
import { DEFAULT_POLICY, totalTransferCost } from "./config.js";
import {
  getCommittedDelta,
  projectPosition,
  type CommittedDeltaStore,
} from "./projection.js";
import { ewmaForecaster } from "./velocity.js";

export interface RankDonorCandidatesOptions {
  includeIneligible?: boolean;
  limit?: number;
  policy?: Policy;
  positions?: readonly (readonly Position[])[];
}

interface InternalCandidate {
  branchIndex: number;
  candidate: DonorCandidate;
}

const BAHRAIN_COORDS_BY_ID = new Map(
  BAHRAIN_BRANCHES.filter((b) => b.coordinates).map((b) => [b.id, b.coordinates!]),
);

function resolveCoordinates(branch: Branch | undefined): readonly [number, number] | undefined {
  if (!branch) return undefined;
  return branch.coordinates ?? BAHRAIN_COORDS_BY_ID.get(branch.id);
}

function roundCoverDays(value: number | null): number | null {
  return value === null ? null : round4(value);
}

function coverSortScore(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function compareCandidates(a: InternalCandidate, b: InternalCandidate): number {
  if (a.candidate.eligible !== b.candidate.eligible) {
    return a.candidate.eligible ? -1 : 1;
  }
  if (a.candidate.netBenefitBhd !== b.candidate.netBenefitBhd) {
    return b.candidate.netBenefitBhd - a.candidate.netBenefitBhd;
  }
  const coverA = coverSortScore(a.candidate.donorCoverDaysAfter);
  const coverB = coverSortScore(b.candidate.donorCoverDaysAfter);
  if (coverA !== coverB) {
    return coverB - coverA;
  }
  return a.branchIndex - b.branchIndex;
}

/**
 * Pure donor ranking for manual/escalated stock requests and transfer rerouting.
 * Reuses projectPosition(), Bahrain Haversine distances, and TotalTransferCost(Q, D).
 */
export function rankDonorCandidates(
  dataset: Dataset,
  committedDeltas: CommittedDeltaStore,
  sku: string,
  targetBranchId: string,
  qty: number,
  opts?: RankDonorCandidatesOptions,
): DonorCandidate[] {
  if (!Number.isFinite(qty) || qty <= 0) return [];
  const requestedQty = Math.ceil(qty);

  const skuIndex = dataset.products.findIndex((p) => p.sku === sku);
  const targetBranchIndex = dataset.branches.findIndex((b) => b.id === targetBranchId);
  if (skuIndex < 0 || targetBranchIndex < 0) return [];

  const product = at(dataset.products, skuIndex, "product");
  const targetBranch = at(dataset.branches, targetBranchIndex, "target branch");
  const policy = opts?.policy ?? DEFAULT_POLICY;
  const positions =
    opts?.positions ?? assessNetwork(dataset, policy, ewmaForecaster, dataset.dates.length);
  const skuPositions = at(positions, skuIndex, "sku positions");
  const targetRaw = at(skuPositions, targetBranchIndex, "target position");

  const targetProj = projectPosition(
    targetRaw,
    getCommittedDelta(committedDeltas, sku, targetBranch.id),
    policy,
  );
  const targetEffectiveOnHand = targetProj.onHand + targetProj.inTransit;
  const targetCoverDaysBefore = roundCoverDays(targetProj.coverDays);
  const targetLostUnits = Math.max(0, targetRaw.velocity * product.leadTimeDays - targetEffectiveOnHand);
  const targetCoords = resolveCoordinates(targetBranch);

  const ranked: InternalCandidate[] = [];

  for (let branchIndex = 0; branchIndex < dataset.branches.length; branchIndex += 1) {
    if (branchIndex === targetBranchIndex) continue;
    const branch = at(dataset.branches, branchIndex, "donor branch");
    const donorRaw = at(skuPositions, branchIndex, "donor position");
    const donorProj = projectPosition(
      donorRaw,
      getCommittedDelta(committedDeltas, sku, branch.id),
      policy,
    );

    const donorCoords = resolveCoordinates(branch);
    const distanceKm =
      donorCoords && targetCoords ? round2(haversineDistanceKm(donorCoords, targetCoords)) : 0;

    if (branch.status === "archived") {
      ranked.push({
        branchIndex,
        candidate: {
          branchId: branch.id,
          branchName: branch.name,
          distanceKm,
          freightCostBhd: totalTransferCost(requestedQty, distanceKm, policy),
          availableSurplusUnits: 0,
          requestedQty,
          offeredQty: 0,
          isPartial: false,
          donorCoverDaysAfter: roundCoverDays(donorProj.coverDays),
          targetCoverDaysBefore,
          targetCoverDaysAfter: targetCoverDaysBefore,
          netBenefitBhd: 0,
          eligible: false,
          ineligibleReason: "ARCHIVED_BRANCH",
        },
      });
      continue;
    }

    const donorFloor = policy.donorCoverDays * donorRaw.velocity + donorRaw.safetyStock;
    const availableSurplusUnits = Math.max(0, Math.floor(donorProj.onHand - donorFloor));

    if (availableSurplusUnits < 1) {
      const ineligibleReason: DonorIneligibleReason =
        donorRaw.inStockDays === 0 && donorProj.onHand === 0
          ? "NO_HISTORY"
          : "INSUFFICIENT_SURPLUS";
      ranked.push({
        branchIndex,
        candidate: {
          branchId: branch.id,
          branchName: branch.name,
          distanceKm,
          freightCostBhd: totalTransferCost(requestedQty, distanceKm, policy),
          availableSurplusUnits: 0,
          requestedQty,
          offeredQty: 0,
          isPartial: false,
          donorCoverDaysAfter: roundCoverDays(donorProj.coverDays),
          targetCoverDaysBefore,
          targetCoverDaysAfter: targetCoverDaysBefore,
          netBenefitBhd: 0,
          eligible: false,
          ineligibleReason,
        },
      });
      continue;
    }

    const offeredQty = Math.min(requestedQty, availableSurplusUnits);
    const isPartial = offeredQty < requestedQty;
    const donorOnHandAfter = donorProj.onHand - offeredQty;
    const donorCoverBefore = coverDaysOf(donorProj.onHand, donorRaw.velocity);
    const donorCoverDaysAfter = roundCoverDays(coverDaysOf(donorOnHandAfter, donorRaw.velocity));
    const targetCoverDaysAfter = roundCoverDays(
      coverDaysOf(targetEffectiveOnHand + offeredQty, targetRaw.velocity),
    );

    const freightCostBhd = totalTransferCost(offeredQty, distanceKm, policy);
    const excessDays = holdingWindowDays(donorCoverBefore, donorRaw.velocity, policy);
    const carryPerUnit =
      product.cost * policy.annualHoldingRate * (excessDays / policy.deadStockHoldDays);
    const lostMarginAvoided = round3(
      Math.min(offeredQty, targetLostUnits) * (product.price - product.cost),
    );
    const carryingCostSaved = round3(offeredQty * carryPerUnit);
    const netBenefitBhd = round3(lostMarginAvoided + carryingCostSaved - freightCostBhd);

    ranked.push({
      branchIndex,
      candidate: {
        branchId: branch.id,
        branchName: branch.name,
        distanceKm,
        freightCostBhd,
        availableSurplusUnits,
        requestedQty,
        offeredQty,
        isPartial,
        donorCoverDaysAfter,
        targetCoverDaysBefore,
        targetCoverDaysAfter,
        netBenefitBhd,
        eligible: true,
      },
    });
  }

  ranked.sort(compareCandidates);

  const eligible = ranked.filter((r) => r.candidate.eligible).map((r) => r.candidate);
  const ineligible = ranked.filter((r) => !r.candidate.eligible).map((r) => r.candidate);
  const limit = opts?.limit ?? 3;

  if (!opts?.includeIneligible) {
    return eligible.slice(0, limit);
  }
  const cappedEligible = opts?.limit !== undefined ? eligible.slice(0, opts.limit) : eligible;
  return [...cappedEligible, ...ineligible];
}
