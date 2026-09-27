import { z } from "zod";

/**
 * A Vouch is generated on every autonomous action — a purchase that
 * completed, one that was held for approval, or one that was cancelled.
 * Shape follows vouch-project-brief.md section 4, extended with the action
 * states and dispute record a real system needs (the brief's example only
 * shows the "Complete, undisputed" case).
 */

export const CorrelationStatus = z.enum(["corroborated", "unconfirmed", "not_applicable"]);
export type CorrelationStatus = z.infer<typeof CorrelationStatus>;

/**
 * "Failed" (added 2026-09-28): an attempt that could not finish — the store
 * was down, the product did not exist, the order step errored. Every
 * attempt leaves a record, including the ones that go wrong; an attempt
 * that vanished without trace would be the one thing a household could not
 * question.
 */
export const VouchActionStatus = z.enum([
  "PendingApproval",
  "Created",
  "Updated",
  "Complete",
  "Cancelled",
  "Failed",
]);
export type VouchActionStatus = z.infer<typeof VouchActionStatus>;

export const ConfidenceLevel = z.enum(["high", "medium", "low"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

export const UserControl = z.enum(["explain", "dispute", "pause_mandate", "adjust_limit"]);
export type UserControl = z.infer<typeof UserControl>;

export const DigitalEvidence = z.object({
  order_id: z.string().nullable(),
  timestamp: z.string().datetime(),
  payment_token_ref: z.string().nullable(),
});
export type DigitalEvidence = z.infer<typeof DigitalEvidence>;

/**
 * `event_type` and `classification` close the action item recorded in
 * BUILD_PLAN.md §1: the old shape carried only an id and a status, so a
 * vehicle passing on the street and a person at the door produced an
 * identical "corroborated" record.
 *
 * Both default to null, so every Vouch written before they existed still
 * parses. They are populated only when a provider actually held an event:
 * "unconfirmed" and "not_applicable" leave them null, because there is
 * nothing to describe. Claiming a classification without an event would be
 * exactly the overclaim the guardrails exist to prevent.
 */
export const PhysicalEvidence = z.object({
  ring_event_id: z.string().nullable(),
  correlation_status: CorrelationStatus,
  /** e.g. "motion_detected" — never a delivery, because Ring publishes none. */
  event_type: z.string().nullable().default(null),
  /** Ring's own vision classification: human / animal / vehicle / other. */
  classification: z.enum(["human", "animal", "vehicle", "other"]).nullable().default(null),
});
export type PhysicalEvidence = z.infer<typeof PhysicalEvidence>;

export const Dispute = z.object({
  disputed_at: z.string().datetime(),
  reason: z.string().optional(),
  /** How much (and in which direction) this dispute moved the mandate's
   *  confidence_threshold — filled in by the reasoning provider. */
  confidence_threshold_delta: z.number().nullable().default(null),
});
export type Dispute = z.infer<typeof Dispute>;

export const Vouch = z.object({
  vouch_id: z.string(),
  created_at: z.string().datetime(),
  intent: z.string(),
  authority: z.object({
    mandate_id: z.string(),
    within_bounds: z.boolean(),
    triggered_rules: z.array(z.string()).default([]),
    /**
     * The two numbers the gate actually compared: the confidence the proposal
     * carried, and the mandate's threshold at that moment. Without them a
     * record could read "confidence high" and "not confident enough" at once
     * — 0.86 is in the high band and still under a tightened 0.88 — and the
     * household had no way to see which was true. The band in `confidence`
     * below is kept for display; these are the evidence.
     *
     * Null on records written before 2026-09-28, which did not keep them.
     */
    confidence_score: z.number().min(0).max(1).nullable().default(null),
    threshold_applied: z.number().min(0).max(1).nullable().default(null),
    /**
     * Where confidence_score came from. The evidence is built from checkable
     * facts (packages/household/src/confidence.ts); the agent's own claim can
     * only lower it. Both are kept, so "the agent said 0.94, the evidence said
     * 0.71" is readable on the record. Null on records before 2026-09-28.
     */
    /** Every check the gate ran, passes included — "How it decided". Null before 2026-09-28. */
    checks: z
      .array(z.object({ rule: z.string(), passed: z.boolean(), detail: z.string() }))
      .nullable()
      .default(null),
    confidence_basis: z
      .object({
        evidence: z.number().min(0).max(1),
        agent_claimed: z.number().min(0).max(1).nullable(),
        factors: z.object({ need: z.number(), product: z.number(), price: z.number() }),
        notes: z.object({ need: z.string(), product: z.string(), price: z.string() }),
      })
      .nullable()
      .default(null),
  }),
  decision: z.object({
    product: z.string(),
    /**
     * The unit price the gate compared. Null only on a Failed attempt that
     * never reached a priced checkout — recorded as unknown rather than as a
     * misleading $0.00.
     */
    price: z.number().nullable(),
    reason: z.array(z.string()),
  }),
  /** Why a Failed attempt failed, and at which stage. Null otherwise. */
  failure: z
    .object({
      stage: z.enum(["checkout", "order"]),
      message: z.string(),
    })
    .nullable()
    .default(null),
  action: z.object({
    ucp_session_id: z.string().nullable(),
    status: VouchActionStatus,
  }),
  evidence: z.object({
    digital: DigitalEvidence,
    physical: PhysicalEvidence,
  }),
  confidence: ConfidenceLevel,
  user_controls: z.array(UserControl),
  dispute: Dispute.nullable().default(null),
  /**
   * Set when the purchase was for a tracked household item. `initiated_by`
   * "forecast" means nobody asked: the household model proposed it, and the
   * numbers it acted on are recorded here so the Vouch can say why in terms a
   * household can check — "you get about 27 days from one; about 2 left".
   */
  /**
   * What actually happened, step by step, with the ids that tie each step to
   * the systems it crossed: who started it (and the MCP request, when an
   * agent did), each UCP call with its Request-Id and Idempotency-Key and the
   * session status it left behind, and the gate's decision between them. A
   * held purchase's trace visibly stops at ready_for_complete.
   */
  trace: z
    .object({
      /**
       * mcp_tool: an agent (or the console) called propose_purchase over MCP.
       * household_agent: the household model, unprompted. household: the
       * household's own "Order it". service: a direct in-process call (tests).
       */
      started_by: z.enum(["mcp_tool", "household_agent", "household", "service"]),
      mcp_request_id: z.string().nullable(),
      steps: z.array(
        z.object({
          step: z.enum(["create", "update", "gate", "household_approval", "household_decline", "complete", "cancel", "error"]),
          at: z.string(),
          request_id: z.string().nullable(),
          idempotency_key: z.string().nullable(),
          /** The UCP session status after this step, or the gate's outcome. */
          result: z.string(),
        })
      ),
    })
    .nullable()
    .default(null),
  /**
   * Set when the household approved a held purchase with its passkey: the
   * exact signed bytes, so anyone with the public key can re-verify that THIS
   * purchase — named in the signed challenge — was approved on the
   * household's device. Null when approved before a passkey existed.
   */
  household_approval: z
    .object({
      credential_id: z.string(),
      /** Recomputes the signed challenge from the action: sha256(nonce ‖ action). */
      nonce: z.string().nullable().default(null),
      action: z.string(),
      description: z.string(),
      signed_at: z.string(),
      client_data_json: z.string(),
      authenticator_data: z.string(),
      signature: z.string(),
    })
    .nullable()
    .default(null),
  household: z
    .object({
      item_id: z.string(),
      initiated_by: z.enum(["forecast", "household"]),
      day: z.number().int(),
      days_per_pack: z.number(),
      days_left: z.object({ low: z.number(), median: z.number(), high: z.number() }).nullable(),
      runout_risk: z.number().min(0).max(1),
      /** Requested delivery day, inside the household's delivery window. Null before windows existed. */
      delivery_day: z.number().int().nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type Vouch = z.infer<typeof Vouch>;
