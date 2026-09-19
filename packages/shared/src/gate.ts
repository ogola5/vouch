import type { Mandate } from "./mandate.ts";

/**
 * The mandate gate: pure, framework-free logic for deciding whether a
 * proposed purchase is within a mandate's bounds. This is deliberately kept
 * dependency-free and synchronous so packages/mcp-server can call it
 * synchronously, in the request path, BEFORE ever calling the mock
 * merchant's Complete step — per the brief's "real gate, not a caption
 * added after the fact" requirement (section 5).
 *
 * Only a small, fixed vocabulary of requires_approval_if expressions is
 * understood right now: "price > max_price", "new_brand", and
 * "quantity > N". Any rule string outside that vocabulary is treated as
 * triggered (fails closed) rather than silently ignored — an unrecognized
 * constraint should never accidentally widen an agent's authority.
 *
 * In the UCP session lifecycle this gate runs on the transition
 * ready_for_complete -> completed: the session may legitimately reach
 * ready_for_complete, but only this function decides whether the MCP
 * server is allowed to POST /checkout-sessions/{id}/complete.
 */

export interface PurchaseProposal {
  /**
   * MAJOR currency units — 25 means $25.00 — matching the human-authored
   * `max_price` on a Mandate ("under $15"). UCP amounts are in ISO 4217
   * MINOR units, so a caller holding a UcpCheckoutSession must convert
   * with toMajorUnits() from ./ucp.js before building a proposal.
   *
   * Getting this wrong in the UCP-amount-into-a-dollar-limit direction
   * fails closed, not open: 1249 minor units ($12.49) compares as 1249
   * against a max_price of 15 and triggers approval on a purchase that
   * should have sailed through. Safe, but it silently breaks the demo's
   * happy path, which is arguably worse for this project than a loud
   * failure. The genuinely unsafe direction is the mirror image — storing
   * a mandate limit in minor units (1500) while proposals arrive in
   * dollars, which lets a $27.80 purchase pass a $15 limit. Mandates are
   * major-units-only for exactly that reason; see mandate.ts.
   */
  price: number;
  quantity: number;
  brand: string;
  /**
   * How sure the agent is that this purchase actually serves the mandate's
   * goal, in [0, 1]. Required rather than optional on purpose: a mandate
   * always carries a confidence_threshold, so a caller that cannot supply
   * a confidence cannot be checked against it, and silently defaulting
   * would make the adaptive loop decorative — which is what it was before
   * this field existed. Making it required means the fail-closed choice is
   * forced at the call site instead of hidden here.
   */
  confidence: number;
}

export interface MandateEvaluation {
  withinBounds: boolean;
  requiresApproval: boolean;
  triggeredRules: string[];
}

const QUANTITY_RULE = /^quantity\s*>\s*(\d+)$/;

/**
 * Rule name reported when the agent's own confidence in a proposal falls
 * below the mandate's current threshold. This is the rule the adaptive
 * loop moves: a dispute raises confidence_threshold, which makes this rule
 * start triggering on proposals that previously passed. It is synthesised
 * by the gate rather than listed in requires_approval_if, because every
 * mandate carries a threshold whether or not its author wrote a rule for it.
 */
export const BELOW_CONFIDENCE_THRESHOLD = "below_confidence_threshold";

export function evaluateProposal(mandate: Mandate, proposal: PurchaseProposal): MandateEvaluation {
  const triggered: string[] = [];
  const { constraints } = mandate;

  if (proposal.confidence < mandate.confidence_threshold) {
    triggered.push(BELOW_CONFIDENCE_THRESHOLD);
  }

  for (const rule of mandate.requires_approval_if) {
    if (rule === "price > max_price") {
      if (constraints.max_price !== undefined && proposal.price > constraints.max_price) {
        triggered.push(rule);
      }
      continue;
    }

    if (rule === "new_brand") {
      const known = [constraints.preferred_brand, constraints.fallback_brand].filter(
        (b): b is string => Boolean(b)
      );
      if (known.length > 0 && !known.includes(proposal.brand)) {
        triggered.push(rule);
      }
      continue;
    }

    const quantityMatch = QUANTITY_RULE.exec(rule);
    if (quantityMatch) {
      const threshold = Number(quantityMatch[1]);
      if (proposal.quantity > threshold) {
        triggered.push(rule);
      }
      continue;
    }

    // Unrecognized rule expression: fail closed.
    triggered.push(rule);
  }

  const requiresApproval = triggered.length > 0 || mandate.status === "paused";
  return {
    withinBounds: !requiresApproval,
    requiresApproval,
    triggeredRules: mandate.status === "paused" ? ["mandate_paused", ...triggered] : triggered,
  };
}
