/**
 * How sure the system may be that THIS purchase is right — built from facts
 * anyone can check, not from the agent's opinion of itself.
 *
 * This closes the open question in BUILD_PLAN.md §7 ("the agent grades its
 * own homework"). The gate compares one number against the mandate's
 * threshold; that number is now evidence, and the agent's own claim can only
 * LOWER it (see gateConfidence). An agent may admit doubt. It may not
 * manufacture certainty.
 *
 * THE FACTOR VALUES ARE ASSUMPTIONS, chosen so the ordering is obviously
 * right — your usual product at your usual price, when you are about to run
 * out, scores highest; a brand you never approved scores lowest — and so the
 * default 0.85 threshold lands in a meaningful place: a usual restock passes,
 * a fallback brand on a forecast passes only until a dispute tightens the
 * threshold, a new brand never passes. They are stated here, and shown on
 * every Vouch, so they can be argued with.
 */

export type NeedBasis =
  /** The household asked for it, in so many words. The request is the need. */
  | { kind: "asked" }
  /** The forecast proposed it. */
  | { kind: "forecast"; runoutRisk: number; status: "stocked" | "out" };

/** How this product relates to what the household buys. */
export type ProductFit = "usual" | "preferred" | "fallback" | "other";

export interface ConfidenceFactors {
  need: number;
  product: number;
  price: number;
}

export interface EvidenceConfidence {
  score: number;
  factors: ConfidenceFactors;
  /** One short phrase per factor, for the "why" a household reads. */
  notes: { need: string; product: string; price: string };
}

const PRODUCT_FACTOR: Record<ProductFit, number> = {
  usual: 1,
  preferred: 0.95,
  fallback: 0.9,
  other: 0.6,
};

const PRODUCT_NOTE: Record<ProductFit, string> = {
  usual: "the product you usually buy",
  preferred: "your preferred brand",
  fallback: "your fallback brand",
  other: "a brand you have not approved",
};

function needFactor(need: NeedBasis): { value: number; note: string } {
  if (need.kind === "asked") return { value: 1, note: "you asked for it" };
  if (need.status === "out") return { value: 1, note: "you are out" };
  const pct = Math.round(need.runoutRisk * 100);
  // Likely to run out before a delivery: clearly needed now. Merely possible:
  // needed, but buying a little early is a small cost of its own.
  return need.runoutRisk >= 0.5
    ? { value: 1, note: `${pct}% likely to run out before a delivery` }
    : { value: 0.95, note: `${pct}% chance of running out before a delivery` };
}

/**
 * @param priceRatio this price divided by what the household usually pays for
 *   this product; null when it has never been bought (no history to judge by —
 *   whether it is within the limit is the gate's job, not this one's).
 */
function priceFactor(priceRatio: number | null): { value: number; note: string } {
  if (priceRatio === null) return { value: 1, note: "no price history yet" };
  const pct = Math.round((priceRatio - 1) * 100);
  if (priceRatio <= 1.05) {
    return { value: 1, note: pct < 0 ? `${-pct}% below what you usually pay` : "about what you usually pay" };
  }
  if (priceRatio <= 1.2) return { value: 0.9, note: `${pct}% above what you usually pay` };
  if (priceRatio <= 1.5) return { value: 0.75, note: `${pct}% above what you usually pay` };
  return { value: 0.5, note: `${pct}% above what you usually pay` };
}

export function evidenceConfidence(input: {
  need: NeedBasis;
  product: ProductFit;
  priceRatio: number | null;
}): EvidenceConfidence {
  const need = needFactor(input.need);
  const price = priceFactor(input.priceRatio);
  const product = PRODUCT_FACTOR[input.product];
  const score = round2(need.value * product * price.value);
  return {
    score,
    factors: { need: need.value, product, price: price.value },
    notes: { need: need.note, product: PRODUCT_NOTE[input.product], price: price.note },
  };
}

/**
 * The number the gate actually compares: the evidence, capped by the agent's
 * own claim if that is lower. Never raised by it.
 */
export function gateConfidence(evidence: number, agentClaimed: number | null): number {
  return agentClaimed === null ? evidence : Math.min(evidence, agentClaimed);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
