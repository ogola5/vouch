import { randomUUID } from "node:crypto";
import {
  Autonomy,
  evaluateProposal,
  newMandate,
  toMajorUnits,
  unrecognizedRules,
  type AuthorityType,
  type ConfidenceLevel,
  type Mandate,
  type MandateEvaluation,
  type UcpCheckoutSession,
  type Vouch,
} from "@vouch/shared";
import type { LedgerReport, VouchStore } from "@vouch/db";
import {
  evidenceConfidence,
  gateConfidence,
  type EvidenceConfidence,
  type HouseholdEvent,
  type NeedBasis,
  type ProductFit,
} from "@vouch/household";
import type { ReasoningProvider } from "@vouch/reasoning";
import type { PhysicalEvidenceProvider } from "@vouch/ring-integration";
import type { MerchantClient, UcpCallIds } from "./merchantClient.ts";

/**
 * Vouch's application layer: mandates in, gated purchases out, a Vouch
 * written for every outcome.
 *
 * Deliberately framework-free — it knows nothing about MCP. The MCP tool
 * definitions in tools.ts are a thin adapter over this class. That split is
 * not tidiness for its own sake: it means the gate can be tested without
 * standing up a transport, and it means a second client (the Fire TV app in
 * week 5) reaches the same gate rather than reimplementing it.
 */

/** Where the household's orders go. Fixed for the demo; a real system would look this up per account. */
export interface HouseholdProfile {
  email: string;
  destination: {
    id: string;
    street_address: string;
    address_locality: string;
    address_region: string;
    postal_code: string;
    address_country: string;
  };
}

export const DEMO_HOUSEHOLD: HouseholdProfile = {
  email: "household@vouch.test",
  destination: {
    id: "home",
    street_address: "1 Demo Street",
    address_locality: "Seattle",
    address_region: "WA",
    postal_code: "98109",
    address_country: "US",
  },
};

export interface VouchServiceDeps {
  store: VouchStore;
  merchant: MerchantClient;
  reasoning: ReasoningProvider;
  physicalEvidence: PhysicalEvidenceProvider;
  household?: HouseholdProfile;
  /**
   * Told about every completed purchase, so the household ledger learns from
   * purchases however they were made — by the forecast, through chat, or
   * approved by the household. Wired in main.ts to HouseholdAgent.
   */
  onPurchaseCompleted?: (completed: {
    vouch: Vouch;
    mandate: Mandate;
    quantity: number;
    /** The merchant's product id, from the UCP line item — not a title. */
    productId: string | null;
  }) => void;
}

/**
 * Why the household model proposed a purchase. INTERNAL: tools.ts does not
 * expose this field, so an agent cannot claim "the forecast says we need it".
 * Only HouseholdAgent's own loop sets it.
 */
export interface HouseholdProposalContext {
  item_id: string;
  day: number;
  need: NeedBasis;
  days_per_pack: number;
  days_left: { low: number; median: number; high: number } | null;
  runout_risk: number;
  /** The household day the delivery is requested for — inside its delivery window. */
  delivery_day: number;
}

type ConfidenceBasis = NonNullable<Vouch["authority"]["confidence_basis"]>;
type HouseholdRecord = Vouch["household"];
type Trace = NonNullable<Vouch["trace"]>;
type TraceStep = Trace["steps"][number];

/**
 * Who started a purchase, for its trace. INTERNAL, like `household`: set by
 * the MCP tool handler, the household agent or the household route — never
 * taken from an agent's arguments.
 */
export interface ProposalOrigin {
  started_by: Trace["started_by"];
  mcp_request_id?: string;
}

export interface CreateMandateInput {
  mandate_id?: string;
  goal: string;
  constraints: Record<string, string | number | boolean>;
  requires_approval_if: string[];
  authority_type: AuthorityType;
  confidence_threshold?: number;
  /**
   * HOUSEHOLD-ONLY. The create_mandate MCP tool does not pass it, so a
   * mandate an agent writes always starts in "ask": an agent must not be able
   * to hand itself the power to buy unprompted.
   */
  autonomy?: Mandate["autonomy"];
}

export interface ProposePurchaseInput {
  mandate_id: string;
  /** Catalog id the merchant knows, e.g. "detergent-brand-a". */
  product_id: string;
  quantity: number;
  /**
   * The brand, as the agent understood it from its catalog search. Unlike
   * price, this is caller-asserted: UCP's item shape carries id, title and
   * price but no brand attribute, so there is nowhere on the session to read
   * it from. It only feeds the `new_brand` rule. Price — the number that
   * decides the money question — is deliberately NOT taken from the caller;
   * see proposePurchase.
   */
  brand: string;
  /**
   * The agent's own confidence, in [0, 1]. ADVISORY SINCE 2026-09-28: the
   * gate compares evidence built from checkable facts, and this can only
   * lower that number, never raise it (see gateConfidence). Absent when the
   * household model proposes on its own.
   */
  confidence?: number;
  /** Why the agent picked this, e.g. ["price_drop", "preferred_brand"]. */
  reason: string[];
  /** Internal only — see HouseholdProposalContext. */
  household?: HouseholdProposalContext;
  /** Internal only — see ProposalOrigin. */
  origin?: ProposalOrigin;
}

export interface ProposePurchaseResult {
  outcome: "completed" | "held_for_approval";
  vouch: Vouch;
  evaluation: MandateEvaluation;
  explanation: string;
  session_status: UcpCheckoutSession["status"];
}

/**
 * Maps a numeric confidence onto the Vouch schema's three-level enum. The
 * bands are the display layer's problem only — the gate always compares the
 * raw number against the mandate's threshold, never these labels.
 */
function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

/**
 * A purchase attempt that went wrong before any order existed. It has
 * ALREADY been recorded as a Failed Vouch; the id says which, so a caller
 * (the chat agent, the household agent) can point at the record.
 */
export class PurchaseFailedError extends Error {
  readonly vouchId: string;
  constructor(message: string, vouchId: string) {
    super(`${message} (recorded as ${vouchId})`);
    this.name = "PurchaseFailedError";
    this.vouchId = vouchId;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** How wide a window around the expected delivery a Ring event still corroborates. */
const RING_CORRELATION_WINDOW_MINUTES = 120;

export class VouchService {
  private readonly store: VouchStore;
  private readonly merchant: MerchantClient;
  private readonly reasoning: ReasoningProvider;
  private readonly physicalEvidence: PhysicalEvidenceProvider;
  private readonly household: HouseholdProfile;
  private onPurchaseCompleted: VouchServiceDeps["onPurchaseCompleted"];
  private onDisputeRecorded: ((disputed: { vouch: Vouch; mandate: Mandate }) => void) | undefined;
  /**
   * The system's "now". The wall clock by default; once a household is set
   * up, its clock — so a fast-forwarded day is also the date the gate checks
   * autonomy expiry against, and the date a Vouch records.
   */
  private now: () => Date = () => new Date();

  setClock(now: () => Date): void {
    this.now = now;
  }

  setDisputeListener(listener: (disputed: { vouch: Vouch; mandate: Mandate }) => void): void {
    this.onDisputeRecorded = listener;
  }

  private onPurchaseDeclined: ((declined: { vouch: Vouch; mandate: Mandate }) => void) | undefined;
  setDeclineListener(listener: (declined: { vouch: Vouch; mandate: Mandate }) => void): void {
    this.onPurchaseDeclined = listener;
  }

  constructor(deps: VouchServiceDeps) {
    this.store = deps.store;
    this.merchant = deps.merchant;
    this.reasoning = deps.reasoning;
    this.physicalEvidence = deps.physicalEvidence;
    this.household = deps.household ?? DEMO_HOUSEHOLD;
    this.onPurchaseCompleted = deps.onPurchaseCompleted;
  }

  /** Lets HouseholdAgent subscribe after both have been constructed. */
  setPurchaseListener(listener: VouchServiceDeps["onPurchaseCompleted"]): void {
    this.onPurchaseCompleted = listener;
  }

  /**
   * Builds the evidence for "is this the right purchase?" from what the
   * household has actually bought: the item ledger when the mandate names a
   * tracked item, otherwise this mandate's completed Vouches.
   */
  private evidenceFor(
    mandate: Mandate,
    purchase: { product_id: string; title: string; brand: string; price: number },
    need: NeedBasis
  ): EvidenceConfidence {
    const itemId = typeof mandate.constraints.item_id === "string" ? mandate.constraints.item_id : null;
    const history: { product: string; price: number | null }[] = itemId
      ? (this.store.listHouseholdEvents(itemId) as HouseholdEvent[])
          .filter((e): e is Extract<HouseholdEvent, { kind: "purchase" }> => e.kind === "purchase" && !!e.product_id)
          .map((e) => ({ product: e.product_id!, price: e.price ?? null }))
      : this.store
          .listVouches({ mandate_id: mandate.mandate_id, limit: 200 })
          .filter((v) => v.action.status === "Complete")
          .reverse()
          .map((v) => ({ product: v.decision.product, price: v.decision.price }));
    const key = itemId ? purchase.product_id : purchase.title;

    const preferred = mandate.constraints.preferred_brand;
    const fallback = mandate.constraints.fallback_brand;
    const fit: ProductFit =
      history.length > 0 && history[history.length - 1]!.product === key
        ? "usual"
        : preferred !== undefined && purchase.brand === preferred
          ? "preferred"
          : fallback !== undefined && purchase.brand === fallback
            ? "fallback"
            : preferred === undefined && fallback === undefined
              ? "preferred" // a mandate that names no brand does not make every brand a stranger
              : mandate.requires_approval_if.includes("new_brand")
                ? "other"
                : // The household removed "ask me about new brands". Evidence must
                  // not quietly reimpose a restriction it deliberately lifted:
                  // allowed, just not what it prefers. (Found by household.test.ts.)
                  "fallback";

    const paid = history.filter((h) => h.product === key && h.price !== null).map((h) => h.price!);
    const typical = median(paid);
    return evidenceConfidence({ need, product: fit, priceRatio: typical === null ? null : purchase.price / typical });
  }

  /* ---------------------------------------------------------------------
   * Mandates
   * ------------------------------------------------------------------ */

  createMandate(input: CreateMandateInput): Mandate {
    const unknown = unrecognizedRules(input.requires_approval_if);
    if (unknown.length > 0) {
      throw new Error(
        `The gate cannot read ${unknown.map((r) => `"${r}"`).join(", ")}. ` +
          `Use only "price > max_price", "new_brand", or "quantity > " followed by a whole number, e.g. "quantity > 2".`
      );
    }
    const mandate = newMandate({
      mandate_id: input.mandate_id ?? `mandate_${randomUUID()}`,
      goal: input.goal,
      constraints: input.constraints,
      requires_approval_if: input.requires_approval_if,
      authority_type: input.authority_type,
      confidence_threshold: input.confidence_threshold,
      autonomy: input.autonomy,
    });
    return this.store.saveMandate(mandate);
  }

  getMandate(mandateId: string): Mandate | null {
    return this.store.getMandate(mandateId);
  }

  listMandates(): Mandate[] {
    return this.store.listMandates();
  }

  pauseMandate(mandateId: string): Mandate {
    return this.store.setMandateStatus(mandateId, "paused");
  }

  resumeMandate(mandateId: string): Mandate {
    return this.store.setMandateStatus(mandateId, "active");
  }

  /**
   * Changes a mandate's limits. HOUSEHOLD-ONLY — deliberately not an MCP tool.
   *
   * The dividing line this whole layer is built on: **the agent may do
   * anything that cannot increase its own authority.** Disputing lowers it,
   * so the agent may relay a dispute. Raising max_price, or lowering the
   * confidence threshold, or un-pausing a paused mandate all widen what the
   * agent is permitted to do next — so an agent holding that power could
   * simply grant itself whatever the gate refused, and every guarantee in
   * this project would be theatre.
   *
   * Reachable only over the household HTTP surface in household.ts, which
   * the console and later the Fire TV app speak. A model never sees it.
   */
  updateMandate(
    mandateId: string,
    changes: {
      goal?: string;
      constraints?: Record<string, string | number | boolean>;
      requires_approval_if?: string[];
      confidence_threshold?: number;
      status?: Mandate["status"];
      /** Mode, end date, delivery days. Widening this is the household's power alone (W3: passkey). */
      autonomy?: Mandate["autonomy"];
    }
  ): Mandate {
    const mandate = this.store.getMandate(mandateId);
    if (!mandate) {
      throw new Error(`No mandate with id "${mandateId}"`);
    }
    if (changes.autonomy !== undefined) Autonomy.parse(changes.autonomy);

    if (changes.confidence_threshold !== undefined) {
      const t = changes.confidence_threshold;
      if (!Number.isFinite(t) || t < 0 || t > 1) {
        throw new Error(`confidence_threshold must be between 0 and 1, got ${t}`);
      }
    }

    return this.store.saveMandate({
      ...mandate,
      goal: changes.goal ?? mandate.goal,
      // Constraints are REPLACED, not merged. Merging would make removing a
      // limit impossible from a form that only ever sends what it has, and a
      // limit you cannot remove is a worse failure than one you must retype.
      constraints: changes.constraints ?? mandate.constraints,
      requires_approval_if: changes.requires_approval_if ?? mandate.requires_approval_if,
      confidence_threshold: changes.confidence_threshold ?? mandate.confidence_threshold,
      // Setting the threshold by hand sets a NEW floor. Only the household
      // can move this number; the loop tightens away from it and recovers
      // back to it, never past it. Leaving the old baseline behind would let
      // a later good streak loosen the agent below what was just chosen.
      baseline_confidence_threshold:
        changes.confidence_threshold ?? mandate.baseline_confidence_threshold,
      status: changes.status ?? mandate.status,
      autonomy: changes.autonomy ?? mandate.autonomy,
      history: {
        ...mandate.history,
        // An edit is an authority change, so it is stamped like one. Without
        // this, a mandate edited by hand and one moved by the adaptive loop
        // would be indistinguishable in the record.
        last_adjusted: this.now().toISOString(),
      },
      updated_at: this.now().toISOString(),
    });
  }

  /* ---------------------------------------------------------------------
   * Discovery
   * ------------------------------------------------------------------ */

  /**
   * What the merchant sells, so an agent can name a real product id.
   *
   * PRICES ARE CONVERTED TO MAJOR UNITS HERE, and that is a deliberate
   * choice about the audience. Everything crossing the UCP boundary is in
   * minor units, but the consumer of this list is a language model, and a
   * model shown `1249` alongside a mandate that says `max_price: 15` will
   * conclude the item costs 1249 dollars and is wildly over budget. The
   * mandate is in major units because a human wrote it; this list is in
   * major units because a model reads it. The one number that must not be
   * caller-supplied — the price the gate actually compares — is still read
   * off the merchant's session in proposePurchase, never from here.
   */
  async searchCatalog(query?: string): Promise<
    { product_id: string; title: string; brand: string; price: number; currency: string }[]
  > {
    const products = await this.merchant.listProducts(query);
    return products.map((product) => ({
      product_id: product.id,
      title: product.title,
      brand: product.brand,
      price: toMajorUnits(product.price, product.currency),
      currency: product.currency,
    }));
  }

  /* ---------------------------------------------------------------------
   * THE GATE
   * ------------------------------------------------------------------ */

  /**
   * Drives a UCP checkout session to `ready_for_complete`, then decides
   * whether it may proceed.
   *
   * THE ORDERING HERE IS THE WHOLE POINT, so it is worth stating outright.
   * The session is created and brought to ready_for_complete FIRST, and the
   * gate runs on the ready_for_complete -> completed transition. That is a
   * real spec state meaning "every requirement is satisfied, the order has
   * NOT been placed" — so a held purchase leaves behind a genuine UCP
   * session parked at exactly the point where the agent's authority ran out,
   * with a session id recorded on the Vouch. Refusing earlier would be
   * easier to implement and much weaker evidence: "we never asked" proves
   * nothing about whether the check works.
   *
   * The price the gate compares is read off the merchant's session, never
   * taken from the caller. An agent that could name its own price for the
   * bounds check could authorise anything.
   *
   * PRICE SEMANTICS: `max_price` is compared against the UNIT price, not the
   * order total. The brief's own demo has a $15 mandate buying 2 units at
   * $12.49 ($24.98 total), so unit price is what "keep detergent stocked
   * under $15" means there. The `quantity > N` rule is what bounds the total
   * exposure. This is a genuine ambiguity in the mandate language and it is
   * resolved here, in one place, rather than differently at each call site.
   */
  async proposePurchase(input: ProposePurchaseInput): Promise<ProposePurchaseResult> {
    const mandate = this.store.getMandate(input.mandate_id);
    if (!mandate) {
      throw new Error(`No mandate with id "${input.mandate_id}"`);
    }

    const steps: TraceStep[] = [];
    const startedBy: Trace["started_by"] = input.household ? "household_agent" : (input.origin?.started_by ?? "service");
    // What was known when it went wrong, if it does — so a Failed record says
    // as much as can honestly be said, and no more.
    const progress: {
      stage: "checkout" | "order";
      ordered: boolean;
      sessionId?: string;
      product?: string;
      price?: number;
      checks?: MandateEvaluation["checks"];
      confidence?: number;
      basis?: ConfidenceBasis;
    } = { stage: "checkout", ordered: false };

    try {
    const session = await this.prepareSession(input.product_id, input.quantity, steps);
    progress.sessionId = session.id;
    const lineItem = session.line_items[0];
    if (!lineItem?.item.price) {
      throw new Error(`Merchant returned a session with no priced line item for "${input.product_id}"`);
    }

    const unitPriceMajor = toMajorUnits(lineItem.item.price, session.currency);
    const product = lineItem.item.title ?? input.product_id;
    progress.product = product;
    progress.price = unitPriceMajor;

    // The number the gate compares is EVIDENCE, capped by the agent's own
    // claim if that is lower. The agent may admit doubt; it may not
    // manufacture certainty. (BUILD_PLAN.md §7, "grades its own homework".)
    const evidence = this.evidenceFor(
      mandate,
      { product_id: input.product_id, title: product, brand: input.brand, price: unitPriceMajor },
      input.household?.need ?? { kind: "asked" }
    );
    const claimed = input.confidence ?? null;
    const confidence = gateConfidence(evidence.score, claimed);
    const basis: ConfidenceBasis = {
      evidence: evidence.score,
      agent_claimed: claimed,
      factors: evidence.factors,
      notes: evidence.notes,
    };
    const householdRecord: HouseholdRecord = input.household
      ? {
          item_id: input.household.item_id,
          initiated_by: "forecast",
          day: input.household.day,
          days_per_pack: input.household.days_per_pack,
          days_left: input.household.days_left,
          runout_risk: input.household.runout_risk,
          delivery_day: input.household.delivery_day,
        }
      : null;

    const now = this.now().toISOString();
    const evaluation = evaluateProposal(mandate, {
      price: unitPriceMajor,
      quantity: input.quantity,
      brand: input.brand,
      confidence,
      // Autonomy is checked only for what the agent started on its own.
      initiatedBy: input.household ? "forecast" : "request",
      at: now,
    });
    steps.push({
      step: "gate",
      at: now,
      request_id: null,
      idempotency_key: null,
      result: evaluation.requiresApproval ? "held — the order was not placed" : "allowed",
    });
    const trace = (): Trace => ({ started_by: startedBy, mcp_request_id: input.origin?.mcp_request_id ?? null, steps });
    progress.checks = evaluation.checks;
    progress.confidence = confidence;
    progress.basis = basis;

    // ---- The gate. Nothing below this line may call completeSession()
    // ---- unless `evaluation.withinBounds` is true.
    if (evaluation.requiresApproval) {
      const vouch: Vouch = {
        vouch_id: `vouch_${randomUUID()}`,
        created_at: now,
        intent: mandate.goal,
        authority: {
          mandate_id: mandate.mandate_id,
          within_bounds: false,
          triggered_rules: evaluation.triggeredRules,
          confidence_score: confidence,
          threshold_applied: mandate.confidence_threshold,
          checks: evaluation.checks,
          confidence_basis: basis,
        },
        decision: { product, price: unitPriceMajor, reason: input.reason },
        action: { ucp_session_id: session.id, status: "PendingApproval" },
        evidence: {
          digital: { order_id: null, timestamp: now, payment_token_ref: null },
          // No purchase was made, so there is nothing a doorbell could
          // corroborate. "not_applicable" rather than "unconfirmed": the
          // latter would imply we are still waiting on evidence.
          physical: {
            ring_event_id: null,
            correlation_status: "not_applicable",
            event_type: null,
            classification: null,
          },
        },
        confidence: confidenceLevel(confidence),
        user_controls: ["explain", "dispute", "pause_mandate", "adjust_limit"],
        dispute: null,
        household: householdRecord,
        household_approval: null,
        trace: trace(),
        failure: null,
      };

      const saved = this.store.saveVouch(vouch);
      return {
        outcome: "held_for_approval",
        vouch: saved,
        evaluation,
        explanation: await this.reasoning.explainVouch({ vouch: saved, mandate }),
        // Left parked at ready_for_complete rather than canceled, so an
        // approval can still complete it — and so the demo can show the
        // session sitting one call short of an order.
        session_status: session.status,
      };
    }

    progress.stage = "order";
    const completed = await this.ucp(steps, "complete", (ids) => this.merchant.completeSession(session.id, ids));
    // From here the order EXISTS. Anything that fails after this point must
    // not be recorded as "Failed" — that would deny a real order.
    progress.ordered = true;
    return this.writeCompletedVouch({
      mandate,
      session: completed,
      product,
      unitPriceMajor,
      reason: input.reason,
      confidenceScore: confidence,
      thresholdApplied: mandate.confidence_threshold,
      confidenceBasis: basis,
      household: householdRecord,
      evaluation,
      trace: trace(),
    });
    } catch (error) {
      if (progress.ordered) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const at = this.now().toISOString();
      steps.push({ step: "error", at, request_id: null, idempotency_key: null, result: message });
      const failed = this.store.saveVouch({
        vouch_id: `vouch_${randomUUID()}`,
        created_at: at,
        intent: mandate.goal,
        authority: {
          mandate_id: mandate.mandate_id,
          within_bounds: false,
          triggered_rules: [],
          confidence_score: progress.confidence ?? null,
          threshold_applied: mandate.confidence_threshold,
          checks: progress.checks ?? null,
          confidence_basis: progress.basis ?? null,
        },
        decision: { product: progress.product ?? input.product_id, price: progress.price ?? null, reason: input.reason },
        action: { ucp_session_id: progress.sessionId ?? null, status: "Failed" },
        evidence: {
          digital: { order_id: null, timestamp: at, payment_token_ref: null },
          physical: { ring_event_id: null, correlation_status: "not_applicable", event_type: null, classification: null },
        },
        confidence: progress.confidence !== undefined ? confidenceLevel(progress.confidence) : "low",
        user_controls: ["explain"],
        dispute: null,
        household: input.household
          ? {
              item_id: input.household.item_id,
              initiated_by: "forecast",
              day: input.household.day,
              days_per_pack: input.household.days_per_pack,
              days_left: input.household.days_left,
              runout_risk: input.household.runout_risk,
              delivery_day: input.household.delivery_day,
            }
          : null,
        household_approval: null,
        trace: { started_by: startedBy, mcp_request_id: input.origin?.mcp_request_id ?? null, steps },
        failure: { stage: progress.stage, message },
      });
      throw new PurchaseFailedError(message, failed.vouch_id);
    }
  }

  /**
   * Declines a held purchase: "keep it blocked". Cancels the checkout that
   * was parked at ready_for_complete, so it cannot be completed later, and
   * records the household's no. Narrows authority, so no passkey.
   */
  async declinePurchase(vouchId: string, reason?: string): Promise<Vouch> {
    const held = this.store.getVouch(vouchId);
    if (!held) throw new Error(`No vouch with id "${vouchId}"`);
    if (held.action.status !== "PendingApproval") {
      throw new Error(`Vouch "${vouchId}" is "${held.action.status}", not "PendingApproval" — nothing to decline`);
    }
    const steps: TraceStep[] = [...(held.trace?.steps ?? [])];
    steps.push({
      step: "household_decline",
      at: this.now().toISOString(),
      request_id: null,
      idempotency_key: null,
      result: reason ? `kept blocked by the household: ${reason}` : "kept blocked by the household",
    });
    const sessionId = held.action.ucp_session_id;
    if (sessionId) await this.ucp(steps, "cancel", (ids) => this.merchant.cancelSession(sessionId, ids));
    const declined = this.store.saveVouch({
      ...held,
      decision: { ...held.decision, reason: [...held.decision.reason, "declined_by_household"] },
      action: { ...held.action, status: "Cancelled" },
      user_controls: ["explain"],
      trace: { started_by: held.trace?.started_by ?? "service", mcp_request_id: held.trace?.mcp_request_id ?? null, steps },
    });
    const mandate = this.store.getMandate(held.authority.mandate_id);
    if (mandate) this.onPurchaseDeclined?.({ vouch: declined, mandate });
    return declined;
  }

  /**
   * Completes a session the gate previously held. This intentionally does
   * NOT re-run the gate: `requires_approval_if` means the purchase needs a
   * human to say yes, and this is that yes. What it does enforce is that a
   * purchase can only be approved from the held state, so this cannot be
   * used to skip the gate on a fresh proposal.
   */
  /**
   * @param approval the household's passkey signature over "approve this
   *   Vouch", when a passkey exists (household.ts enforces that it does).
   *   Written onto the record so the approval can be re-verified later.
   */
  async approvePurchase(vouchId: string, approval: Vouch["household_approval"] = null): Promise<ProposePurchaseResult> {
    const held = this.store.getVouch(vouchId);
    if (!held) {
      throw new Error(`No vouch with id "${vouchId}"`);
    }
    if (held.action.status !== "PendingApproval") {
      throw new Error(
        `Vouch "${vouchId}" is "${held.action.status}", not "PendingApproval" — nothing to approve`
      );
    }
    if (!held.action.ucp_session_id) {
      throw new Error(`Vouch "${vouchId}" has no checkout session to complete`);
    }

    const mandate = this.store.getMandate(held.authority.mandate_id);
    if (!mandate) {
      throw new Error(`No mandate with id "${held.authority.mandate_id}"`);
    }

    // The same trace, continued: the household's yes, then the order.
    const steps: TraceStep[] = [...(held.trace?.steps ?? [])];
    steps.push({
      step: "household_approval",
      at: this.now().toISOString(),
      request_id: null,
      idempotency_key: null,
      result: approval ? "approved with the household's passkey" : "approved by the household",
    });
    const sessionId = held.action.ucp_session_id;
    const completed = await this.ucp(steps, "complete", (ids) => this.merchant.completeSession(sessionId, ids));
    return this.writeCompletedVouch({
      mandate,
      session: completed,
      product: held.decision.product,
      // A held purchase always reached a priced checkout; only Failed ones may not.
      unitPriceMajor: held.decision.price ?? 0,
      reason: [...held.decision.reason, "approved_by_household"],
      // The AGENT's numbers from when it proposed, not a synthetic 1. The
      // household's yes does not make the agent retroactively confident, and
      // recording it as "high" would misstate what the agent believed.
      confidenceScore: held.authority.confidence_score,
      thresholdApplied: held.authority.threshold_applied,
      confidenceBasis: held.authority.confidence_basis,
      household: held.household,
      confidenceBand: held.confidence,
      evaluation: {
        withinBounds: true,
        requiresApproval: false,
        // Kept, not cleared: the record should still show what had stopped
        // it, otherwise an approved purchase is indistinguishable from one
        // that never needed asking.
        triggeredRules: held.authority.triggered_rules,
        checks: [
          ...(held.authority.checks ?? []),
          {
            rule: "household_approval",
            passed: true,
            detail: approval ? "the household approved it with its passkey" : "the household approved it",
          },
        ],
      },
      vouchId: held.vouch_id,
      approval,
      trace: { started_by: held.trace?.started_by ?? "service", mcp_request_id: held.trace?.mcp_request_id ?? null, steps },
    });
  }

  /* ---------------------------------------------------------------------
   * Disputes — the adaptive loop
   * ------------------------------------------------------------------ */

  /**
   * The differentiating mechanism (brief section 4): a dispute tightens the
   * mandate's confidence threshold, so the *next* borderline proposal in the
   * same category is held where an identical one previously passed.
   */
  async recordDispute(input: { vouch_id: string; reason?: string }): Promise<{
    vouch: Vouch;
    mandate: Mandate;
    threshold_before: number;
    threshold_after: number;
    rationale: string;
  }> {
    const vouch = this.store.getVouch(input.vouch_id);
    if (!vouch) {
      throw new Error(`No vouch with id "${input.vouch_id}"`);
    }
    const mandate = this.store.getMandate(vouch.authority.mandate_id);
    if (!mandate) {
      throw new Error(`No mandate with id "${vouch.authority.mandate_id}"`);
    }

    const adjustment = await this.reasoning.adjustConfidenceThreshold({
      mandate,
      event: { kind: "dispute", reason: input.reason },
    });

    const result = this.store.recordDispute({
      vouch_id: input.vouch_id,
      reason: input.reason,
      newThreshold: adjustment.newThreshold,
      delta: adjustment.delta,
    });
    // Trust lost: a household that disputes a purchase gets asked next time
    // (HouseholdAgent demotes the item from Auto to Ask). Narrows authority,
    // so it happens at once, with no passkey.
    this.onDisputeRecorded?.({ vouch: result.vouch, mandate: result.change.mandate });

    return {
      vouch: result.vouch,
      mandate: result.change.mandate,
      threshold_before: result.change.threshold_before,
      threshold_after: result.change.threshold_after,
      rationale: adjustment.rationale,
    };
  }

  /* ---------------------------------------------------------------------
   * Queries
   * ------------------------------------------------------------------ */

  listVouches(filter: { mandate_id?: string; since?: string; limit?: number } = {}): Vouch[] {
    return this.store.listVouches(filter);
  }

  /* The tamper-evident record (W3b) — see packages/db ledger. */
  ledgerHead(): { seq: number; hash: string } | null {
    return this.store.ledgerHead();
  }
  ledgerEntry(seq: number): { seq: number; hash: string } | null {
    return this.store.ledgerEntry(seq);
  }
  verifyLedger(): LedgerReport {
    return this.store.verifyLedger();
  }
  /** DEMO CONTROL: see VouchStore.tamperForDemo. */
  tamperForDemo(vouchId: string, price: number): void {
    this.store.tamperForDemo(vouchId, price);
  }

  async explainVouch(vouchId: string): Promise<string> {
    const vouch = this.store.getVouch(vouchId);
    if (!vouch) {
      throw new Error(`No vouch with id "${vouchId}"`);
    }
    const mandate = this.store.getMandate(vouch.authority.mandate_id);
    if (!mandate) {
      throw new Error(`No mandate with id "${vouch.authority.mandate_id}"`);
    }
    return this.reasoning.explainVouch({ vouch, mandate });
  }

  /* ---------------------------------------------------------------------
   * Internals
   * ------------------------------------------------------------------ */

  /**
   * Create -> Update, leaving the session at ready_for_complete. Everything
   * the spec needs before an order can be placed (buyer, destination,
   * fulfillment option, payment instrument) is supplied here, so that when
   * the gate refuses, the *only* thing standing between the session and an
   * order is the gate itself.
   */
  /**
   * Every UCP call goes through here: the ids are generated HERE, sent as the
   * Request-Id / Idempotency-Key headers, and written onto the trace with the
   * session status the call left behind.
   */
  private async ucp(
    steps: TraceStep[],
    step: "create" | "update" | "complete" | "cancel",
    call: (ids: UcpCallIds) => Promise<UcpCheckoutSession>
  ): Promise<UcpCheckoutSession> {
    const ids: UcpCallIds = { requestId: randomUUID(), ...(step === "create" ? { idempotencyKey: randomUUID() } : {}) };
    const session = await call(ids);
    steps.push({
      step,
      at: this.now().toISOString(),
      request_id: ids.requestId,
      idempotency_key: ids.idempotencyKey ?? null,
      result: session.status,
    });
    return session;
  }

  private async prepareSession(productId: string, quantity: number, steps: TraceStep[]): Promise<UcpCheckoutSession> {
    const created = await this.ucp(steps, "create", (ids) =>
      this.merchant.createSession(
        {
          line_items: [{ item: { id: productId }, quantity }],
          buyer: { email: this.household.email },
          currency: "USD",
        },
        ids
      )
    );

    const method = created.fulfillment?.methods[0];
    const updated = await this.ucp(steps, "update", (ids) => this.merchant.updateSession(created.id, {
      buyer: { email: this.household.email },
      fulfillment: method
        ? {
            methods: [
              {
                ...method,
                selected_destination_id: this.household.destination.id,
                destinations: [this.household.destination],
                groups: method.groups.map((group) => ({
                  ...group,
                  selected_option_id: group.selected_option_id ?? group.options[0]?.id,
                })),
              },
            ],
          }
        : undefined,
      payment: {
        instruments: [
          {
            id: "instrument_demo",
            handler_id: "dev.vouch.mock_pay",
            type: "card",
            selected: true,
            display: { brand: "demo", last4: "4242" },
          },
        ],
      },
    }, ids));

    if (updated.status !== "ready_for_complete") {
      throw new Error(
        `Session ${updated.id} did not reach ready_for_complete (status "${updated.status}"): ` +
          `${(updated.messages ?? []).map((m) => m.content).join("; ")}`
      );
    }
    return updated;
  }

  private async writeCompletedVouch(args: {
    mandate: Mandate;
    session: UcpCheckoutSession;
    product: string;
    unitPriceMajor: number;
    reason: string[];
    /** Null only for an approval of a record that predates these fields. */
    confidenceScore: number | null;
    thresholdApplied: number | null;
    confidenceBasis: ConfidenceBasis | null;
    household: HouseholdRecord;
    /** Given when approving, so the band is carried over rather than recomputed. */
    confidenceBand?: ConfidenceLevel;
    evaluation: MandateEvaluation;
    vouchId?: string;
    approval?: Vouch["household_approval"];
    trace: Trace;
  }): Promise<ProposePurchaseResult> {
    const { mandate, session, evaluation } = args;
    const now = this.now().toISOString();
    const orderId = session.order?.id ?? null;

    /*
     * HONESTY RULE (brief sections 4 and 9): this correlates a doorstep
     * motion event against the window the order was expected in. It is not
     * proof the order arrived, and `correlation_status` must never collapse
     * to a boolean "delivered". Ring publishes no package-delivered webhook
     * — motion, button press and device lifecycle events are the whole list
     * — so there is no stronger claim available to make, from the mock or
     * from a real provider. See BUILD_PLAN.md section 1.
     */
    // A doorbell that errors must not cost the household the record of a
    // real order: fall back to "unconfirmed" — no event has been seen, which
    // is exactly true — and write the Vouch regardless.
    const physical = orderId
      ? await this.physicalEvidence
          .correlateDelivery({
            order_id: orderId,
            expected_around: now,
            window_minutes: RING_CORRELATION_WINDOW_MINUTES,
          })
          .catch(() => ({
            ring_event_id: null,
            correlation_status: "unconfirmed" as const,
            event_type: null,
            classification: null,
          }))
      : {
          ring_event_id: null,
          correlation_status: "not_applicable" as const,
          event_type: null,
          classification: null,
        };

    const vouch: Vouch = {
      vouch_id: args.vouchId ?? `vouch_${randomUUID()}`,
      created_at: now,
      intent: mandate.goal,
      authority: {
        mandate_id: mandate.mandate_id,
        within_bounds: evaluation.withinBounds,
        triggered_rules: evaluation.triggeredRules,
        confidence_score: args.confidenceScore,
        threshold_applied: args.thresholdApplied,
        checks: evaluation.checks,
        confidence_basis: args.confidenceBasis,
      },
      decision: { product: args.product, price: args.unitPriceMajor, reason: args.reason },
      action: { ucp_session_id: session.id, status: "Complete" },
      evidence: {
        digital: {
          order_id: orderId,
          timestamp: now,
          payment_token_ref: session.payment?.instruments.find((i) => i.selected)?.id ?? null,
        },
        physical,
      },
      confidence:
        args.confidenceBand ?? (args.confidenceScore === null ? "low" : confidenceLevel(args.confidenceScore)),
      user_controls: ["explain", "dispute", "pause_mandate", "adjust_limit"],
      dispute: null,
      household: args.household,
      household_approval: args.approval ?? null,
      trace: args.trace,
      failure: null,
    };

    const saved = this.store.saveVouch(vouch);
    this.onPurchaseCompleted?.({
      vouch: saved,
      mandate,
      quantity: session.line_items[0]?.quantity ?? 1,
      productId: session.line_items[0]?.item.id ?? null,
    });

    /*
     * The recovery half of the adaptive loop. An undisputed purchase counts
     * toward a streak that gradually widens the mandate's threshold back.
     * Counted at completion rather than after some settling period because
     * the demo has no time to wait — a real deployment would want a dispute
     * window to close first, and that is worth naming in the writeup rather
     * than glossing.
     */
    const streakLength = mandate.history.undisputed_actions + 1;
    const recovery = await this.reasoning.adjustConfidenceThreshold({
      mandate,
      event: { kind: "undisputed_streak", streakLength },
    });
    this.store.applyUndisputedAction({
      mandate_id: mandate.mandate_id,
      newThreshold: recovery.newThreshold,
    });

    return {
      outcome: "completed",
      vouch: saved,
      evaluation,
      explanation: await this.reasoning.explainVouch({ vouch: saved, mandate }),
      session_status: session.status,
    };
  }
}
