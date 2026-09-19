import { randomUUID } from "node:crypto";
import {
  evaluateProposal,
  newMandate,
  toMajorUnits,
  type AuthorityType,
  type ConfidenceLevel,
  type Mandate,
  type MandateEvaluation,
  type UcpCheckoutSession,
  type Vouch,
} from "@vouch/shared";
import type { VouchStore } from "@vouch/db";
import type { ReasoningProvider } from "@vouch/reasoning";
import type { PhysicalEvidenceProvider } from "@vouch/ring-integration";
import type { MerchantClient } from "./merchantClient.ts";

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
}

export interface CreateMandateInput {
  mandate_id?: string;
  goal: string;
  constraints: Record<string, string | number | boolean>;
  requires_approval_if: string[];
  authority_type: AuthorityType;
  confidence_threshold?: number;
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
  /** The agent's own confidence that this purchase serves the mandate, in [0, 1]. */
  confidence: number;
  /** Why the agent picked this, e.g. ["price_drop", "preferred_brand"]. */
  reason: string[];
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

/** How wide a window around the expected delivery a Ring event still corroborates. */
const RING_CORRELATION_WINDOW_MINUTES = 120;

export class VouchService {
  private readonly store: VouchStore;
  private readonly merchant: MerchantClient;
  private readonly reasoning: ReasoningProvider;
  private readonly physicalEvidence: PhysicalEvidenceProvider;
  private readonly household: HouseholdProfile;

  constructor(deps: VouchServiceDeps) {
    this.store = deps.store;
    this.merchant = deps.merchant;
    this.reasoning = deps.reasoning;
    this.physicalEvidence = deps.physicalEvidence;
    this.household = deps.household ?? DEMO_HOUSEHOLD;
  }

  /* ---------------------------------------------------------------------
   * Mandates
   * ------------------------------------------------------------------ */

  createMandate(input: CreateMandateInput): Mandate {
    const mandate = newMandate({
      mandate_id: input.mandate_id ?? `mandate_${randomUUID()}`,
      goal: input.goal,
      constraints: input.constraints,
      requires_approval_if: input.requires_approval_if,
      authority_type: input.authority_type,
      confidence_threshold: input.confidence_threshold,
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
    }
  ): Mandate {
    const mandate = this.store.getMandate(mandateId);
    if (!mandate) {
      throw new Error(`No mandate with id "${mandateId}"`);
    }

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
      status: changes.status ?? mandate.status,
      history: {
        ...mandate.history,
        // An edit is an authority change, so it is stamped like one. Without
        // this, a mandate edited by hand and one moved by the adaptive loop
        // would be indistinguishable in the record.
        last_adjusted: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
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

    const session = await this.prepareSession(input.product_id, input.quantity);
    const lineItem = session.line_items[0];
    if (!lineItem?.item.price) {
      throw new Error(`Merchant returned a session with no priced line item for "${input.product_id}"`);
    }

    const unitPriceMajor = toMajorUnits(lineItem.item.price, session.currency);
    const evaluation = evaluateProposal(mandate, {
      price: unitPriceMajor,
      quantity: input.quantity,
      brand: input.brand,
      confidence: input.confidence,
    });

    const product = lineItem.item.title ?? input.product_id;
    const now = new Date().toISOString();

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
        },
        decision: { product, price: unitPriceMajor, reason: input.reason },
        action: { ucp_session_id: session.id, status: "PendingApproval" },
        evidence: {
          digital: { order_id: null, timestamp: now, payment_token_ref: null },
          // No purchase was made, so there is nothing a doorbell could
          // corroborate. "not_applicable" rather than "unconfirmed": the
          // latter would imply we are still waiting on evidence.
          physical: { ring_event_id: null, correlation_status: "not_applicable" },
        },
        confidence: confidenceLevel(input.confidence),
        user_controls: ["explain", "dispute", "pause_mandate", "adjust_limit"],
        dispute: null,
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

    const completed = await this.merchant.completeSession(session.id);
    return this.writeCompletedVouch({
      mandate,
      session: completed,
      product,
      unitPriceMajor,
      reason: input.reason,
      confidence: input.confidence,
      evaluation,
    });
  }

  /**
   * Completes a session the gate previously held. This intentionally does
   * NOT re-run the gate: `requires_approval_if` means the purchase needs a
   * human to say yes, and this is that yes. What it does enforce is that a
   * purchase can only be approved from the held state, so this cannot be
   * used to skip the gate on a fresh proposal.
   */
  async approvePurchase(vouchId: string): Promise<ProposePurchaseResult> {
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

    const completed = await this.merchant.completeSession(held.action.ucp_session_id);
    return this.writeCompletedVouch({
      mandate,
      session: completed,
      product: held.decision.product,
      unitPriceMajor: held.decision.price,
      reason: [...held.decision.reason, "approved_by_household"],
      confidence: 1,
      evaluation: {
        withinBounds: true,
        requiresApproval: false,
        // Kept, not cleared: the record should still show what had stopped
        // it, otherwise an approved purchase is indistinguishable from one
        // that never needed asking.
        triggeredRules: held.authority.triggered_rules,
      },
      vouchId: held.vouch_id,
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
  private async prepareSession(productId: string, quantity: number): Promise<UcpCheckoutSession> {
    const created = await this.merchant.createSession({
      line_items: [{ item: { id: productId }, quantity }],
      buyer: { email: this.household.email },
      currency: "USD",
    });

    const method = created.fulfillment?.methods[0];
    const updated = await this.merchant.updateSession(created.id, {
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
    });

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
    confidence: number;
    evaluation: MandateEvaluation;
    vouchId?: string;
  }): Promise<ProposePurchaseResult> {
    const { mandate, session, evaluation } = args;
    const now = new Date().toISOString();
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
    const physical = orderId
      ? await this.physicalEvidence.correlateDelivery({
          order_id: orderId,
          expected_around: now,
          window_minutes: RING_CORRELATION_WINDOW_MINUTES,
        })
      : { ring_event_id: null, correlation_status: "not_applicable" as const };

    const vouch: Vouch = {
      vouch_id: args.vouchId ?? `vouch_${randomUUID()}`,
      created_at: now,
      intent: mandate.goal,
      authority: {
        mandate_id: mandate.mandate_id,
        within_bounds: evaluation.withinBounds,
        triggered_rules: evaluation.triggeredRules,
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
      confidence: confidenceLevel(args.confidence),
      user_controls: ["explain", "dispute", "pause_mandate", "adjust_limit"],
      dispute: null,
    };

    const saved = this.store.saveVouch(vouch);

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
