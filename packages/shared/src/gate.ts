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
  /**
   * Who started this purchase. "forecast" means nobody asked — the household
   * model decided it was time — so the mandate's AUTONOMY is checked as well
   * as its limits. Omitted means a request (a person asked, directly or via
   * the chat agent), which autonomy does not govern.
   */
  initiatedBy?: "request" | "forecast";
  /**
   * When, as an ISO 8601 datetime — needed to check autonomy's end date.
   * A forecast-initiated proposal without it fails closed if the mandate's
   * autonomy has an end date: "we could not tell whether it had expired"
   * must mean held, never allowed.
   */
  at?: string;
}

/**
 * One thing the gate checked, and what it found — passes as well as
 * failures. `triggeredRules` says why a purchase was held; `checks` says
 * everything that was looked at, so a record can show "under your $15 limit ✓,
 * a brand you approved ✓, confidence 0.95 ≥ 0.85 ✓" and not only the reasons
 * something failed. Additive: the decision is made exactly as before.
 */
export interface GateCheck {
  rule: string;
  passed: boolean;
  /** The comparison, in plain terms: "$12.49 ≤ $15.00". */
  detail: string;
}

export interface MandateEvaluation {
  withinBounds: boolean;
  requiresApproval: boolean;
  triggeredRules: string[];
  checks: GateCheck[];
}

const money = (n: number) => `$${n.toFixed(2)}`;

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

/**
 * Synthesized for purchases the agent started on its own (initiatedBy
 * "forecast"). Same shape as `mandate_paused`: a check on the mandate's
 * authority status, not on the purchase's contents — see BUILD_PLAN.md §3b
 * for why this is not the "third concern" the Reviewed-and-kept note warns of.
 */
export const AUTONOMY_NOT_GRANTED = "autonomy_not_granted";
export const AUTONOMY_EXPIRED = "autonomy_expired";

const KNOWN_RULES = new Set(["price > max_price", "new_brand"]);

/**
 * The rules in a list that the gate cannot read. Used to refuse such a mandate
 * at creation time: evaluateProposal still fails closed on them, but a mandate
 * whose every purchase is held is useless, and saying so while the agent is
 * still in the turn lets it fix the rule instead of leaving a dead mandate.
 * First hit live: a model copied the placeholder "quantity > N" verbatim.
 */
export function unrecognizedRules(rules: string[]): string[] {
  return rules.filter((rule) => !KNOWN_RULES.has(rule) && !QUANTITY_RULE.test(rule));
}

export function evaluateProposal(mandate: Mandate, proposal: PurchaseProposal): MandateEvaluation {
  const triggered: string[] = [];
  const checks: GateCheck[] = [];
  const { constraints } = mandate;
  const check = (rule: string, passed: boolean, detail: string) => {
    checks.push({ rule, passed, detail });
    if (!passed) triggered.push(rule);
  };

  checks.push({
    rule: "mandate_active",
    passed: mandate.status !== "paused",
    detail: mandate.status === "paused" ? "paused by the household" : "active",
  });

  check(
    BELOW_CONFIDENCE_THRESHOLD,
    proposal.confidence >= mandate.confidence_threshold,
    `confidence ${proposal.confidence.toFixed(2)} ${proposal.confidence >= mandate.confidence_threshold ? "≥" : "<"} ${mandate.confidence_threshold.toFixed(2)}`
  );

  if (proposal.initiatedBy === "forecast") {
    const autonomy = mandate.autonomy;
    if (autonomy.mode !== "auto") {
      // Remind and Ask mean "tell me, don't buy". An unprompted purchase
      // under either is held — whatever the loop that proposed it believed.
      check(AUTONOMY_NOT_GRANTED, false, `nobody asked, and this item is on "${autonomy.mode}"`);
    } else if (autonomy.until !== null) {
      const day = proposal.at?.slice(0, 10);
      check(
        AUTONOMY_EXPIRED,
        Boolean(day) && day! <= autonomy.until,
        day ? `${day} ${day <= autonomy.until ? "≤" : ">"} ${autonomy.until}` : "could not tell the date — held"
      );
    } else {
      checks.push({ rule: "autonomy", passed: true, detail: "nobody asked, and this item is on Auto" });
    }
  }

  for (const rule of mandate.requires_approval_if) {
    if (rule === "price > max_price") {
      const max = constraints.max_price;
      check(rule, max === undefined || proposal.price <= max, max === undefined ? "no limit set" : `${money(proposal.price)} ${proposal.price <= max ? "≤" : ">"} ${money(max)}`);
      continue;
    }

    if (rule === "new_brand") {
      const known = [constraints.preferred_brand, constraints.fallback_brand].filter(
        (b): b is string => Boolean(b)
      );
      const ok = known.length === 0 || known.includes(proposal.brand);
      check(rule, ok, known.length === 0 ? "no brands named" : `${proposal.brand} ${ok ? "is" : "is not"} one of ${known.join(", ")}`);
      continue;
    }

    const quantityMatch = QUANTITY_RULE.exec(rule);
    if (quantityMatch) {
      const threshold = Number(quantityMatch[1]);
      check(rule, proposal.quantity <= threshold, `${proposal.quantity} ${proposal.quantity <= threshold ? "≤" : ">"} ${threshold}`);
      continue;
    }

    // Unrecognized rule expression: fail closed.
    check(rule, false, "not a rule the gate understands — held rather than guessed");
  }

  const requiresApproval = triggered.length > 0 || mandate.status === "paused";
  return {
    withinBounds: !requiresApproval,
    requiresApproval,
    triggeredRules: mandate.status === "paused" ? ["mandate_paused", ...triggered] : triggered,
    checks,
  };
}
