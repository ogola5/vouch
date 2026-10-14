import { Mandate, Vouch } from "@vouch/shared";

/** Records for the explanation tests: one per kind of thing a household asks "why?" about. */

const NOW = "2026-10-14T10:00:00.000Z";

export const mandate = Mandate.parse({
  mandate_id: "m_detergent",
  goal: "Keep laundry detergent stocked",
  constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
  requires_approval_if: ["price > max_price", "new_brand"],
  authority_type: "explicit",
  confidence_threshold: 0.88,
  baseline_confidence_threshold: 0.85,
  history: {},
  created_at: NOW,
  updated_at: NOW,
});

type Status = "PendingApproval" | "Complete" | "Failed" | "Cancelled";

export function record(
  name: string,
  status: Status,
  opts: {
    product: string;
    price: number | null;
    triggered?: string[];
    checks?: { rule: string; passed: boolean; detail: string }[];
    confidence?: number;
    doorbell?: "corroborated" | "unconfirmed" | "not_applicable";
    failure?: string;
  }
): Vouch {
  return Vouch.parse({
    vouch_id: `v_${name}`,
    created_at: NOW,
    intent: "restock detergent",
    authority: {
      mandate_id: mandate.mandate_id,
      within_bounds: status === "Complete",
      triggered_rules: opts.triggered ?? [],
      checks: opts.checks ?? [],
      confidence_score: opts.confidence ?? null,
      threshold_applied: opts.confidence === undefined ? null : mandate.confidence_threshold,
    },
    decision: { product: opts.product, price: opts.price, reason: ["running low"] },
    failure: opts.failure ? { stage: "checkout", message: opts.failure } : null,
    action: { ucp_session_id: null, status },
    evidence: {
      digital: { order_id: status === "Complete" ? "ord_1" : null, timestamp: NOW, payment_token_ref: null },
      physical: { ring_event_id: null, correlation_status: opts.doorbell ?? "not_applicable" },
    },
    confidence: "high",
    user_controls: ["explain"],
  });
}

/** The six kinds of record the console can show. */
export const SCENARIOS: { name: string; vouch: Vouch; mustMention: RegExp[] }[] = [
  {
    name: "held: over the limit, new brand",
    vouch: record("held_price_brand", "PendingApproval", {
      product: "Brand C Detergent",
      price: 27.99,
      triggered: ["price > max_price", "new_brand"],
      checks: [
        { rule: "price > max_price", passed: false, detail: "$27.99 > $15.00" },
        { rule: "new_brand", passed: false, detail: "Brand C is not Brand A or Brand B" },
      ],
    }),
    mustMention: [/27\.99/, /15/],
  },
  {
    name: "held: not confident enough after a dispute",
    vouch: record("held_confidence", "PendingApproval", {
      product: "Brand A Detergent",
      price: 13.99,
      triggered: ["below_confidence_threshold"],
      confidence: 0.86,
      checks: [
        { rule: "price > max_price", passed: true, detail: "$13.99 ≤ $15.00" },
        { rule: "below_confidence_threshold", passed: false, detail: "0.86 < 0.88" },
      ],
    }),
    mustMention: [/13\.99/],
  },
  {
    name: "bought, doorbell corroborated",
    vouch: record("bought_corroborated", "Complete", {
      product: "Brand A Detergent",
      price: 12.49,
      doorbell: "corroborated",
      checks: [{ rule: "price > max_price", passed: true, detail: "$12.49 ≤ $15.00" }],
    }),
    mustMention: [/12\.49/],
  },
  {
    name: "bought, doorbell unconfirmed",
    vouch: record("bought_unconfirmed", "Complete", {
      product: "Brand B Detergent",
      price: 14.25,
      doorbell: "unconfirmed",
      checks: [{ rule: "price > max_price", passed: true, detail: "$14.25 ≤ $15.00" }],
    }),
    mustMention: [/14\.25/],
  },
  {
    name: "failed: store down",
    vouch: record("failed", "Failed", { product: "Brand A Detergent", price: null, failure: "the store answered 503" }),
    mustMention: [/nothing|not/i],
  },
  {
    name: "cancelled: household kept it blocked",
    vouch: record("cancelled", "Cancelled", { product: "Brand C Detergent", price: 27.99 }),
    mustMention: [/27\.99/],
  },
];
