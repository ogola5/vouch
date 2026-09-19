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

export const VouchActionStatus = z.enum([
  "PendingApproval",
  "Created",
  "Updated",
  "Complete",
  "Cancelled",
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

export const PhysicalEvidence = z.object({
  ring_event_id: z.string().nullable(),
  correlation_status: CorrelationStatus,
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
  }),
  decision: z.object({
    product: z.string(),
    price: z.number(),
    reason: z.array(z.string()),
  }),
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
});
export type Vouch = z.infer<typeof Vouch>;
