import { z } from "zod";

/**
 * A Mandate is the plain-language, structured authority boundary an agent must
 * check BEFORE acting. It is the object every autonomous purchase is gated
 * against — see packages/mcp-server's propose_purchase tool, which is the one
 * place in the whole system that is allowed to read a Mandate and decide
 * whether a UCP session may proceed to Complete.
 *
 * Shape follows vouch-project-brief.md section 4, with a few additions
 * (status, timestamps) that the brief's example omitted but that a real
 * system needs to support "pause_mandate" and auditability.
 */

export const AuthorityType = z.enum(["explicit", "delegated", "inferred"]);
export type AuthorityType = z.infer<typeof AuthorityType>;

export const MandateStatus = z.enum(["active", "paused"]);
export type MandateStatus = z.infer<typeof MandateStatus>;

/**
 * Known constraint keys are typed explicitly; the catchall allows a mandate
 * to carry additional category-specific constraints later (week 2+) without
 * a schema migration every time.
 */
export const MandateConstraints = z
  .object({
    /**
     * MAJOR currency units — 15 means $15.00. Mandates are written by
     * humans in plain language ("under $15 monthly"), so they stay in
     * major units and never adopt UCP's ISO 4217 minor units; converting
     * at the UCP boundary with toMajorUnits() keeps the unsafe direction
     * (a minor-unit limit silently admitting a major-unit price) from
     * being expressible at all. See gate.ts.
     */
    max_price: z.number().positive().optional(),
    quantity: z.number().int().positive().optional(),
    frequency: z.string().optional(), // ISO 8601 duration, e.g. "P1M"
    preferred_brand: z.string().optional(),
    fallback_brand: z.string().optional(),
  })
  .catchall(z.union([z.string(), z.number(), z.boolean()]));
export type MandateConstraints = z.infer<typeof MandateConstraints>;

export const MandateHistory = z.object({
  undisputed_actions: z.number().int().nonnegative().default(0),
  disputed_actions: z.number().int().nonnegative().default(0),
  last_adjusted: z.string().datetime().nullable().default(null),
});
export type MandateHistory = z.infer<typeof MandateHistory>;

export const Mandate = z.object({
  mandate_id: z.string(),
  goal: z.string(),
  constraints: MandateConstraints,
  /**
   * Rule expressions evaluated by the MCP server's gate, e.g.
   * "price > max_price", "new_brand", "quantity > 2". Week 2 defines the
   * exact rule evaluation grammar; for now these are opaque strings matched
   * by name in packages/mcp-server.
   */
  requires_approval_if: z.array(z.string()),
  authority_type: AuthorityType,
  confidence_threshold: z.number().min(0).max(1),
  /**
   * The threshold the HOUSEHOLD set, and a floor the adaptive loop may never
   * loosen below.
   *
   * Added after a 12,000-decision trial found the loop violating this
   * project's own rule that the agent may do nothing which increases its own
   * authority. Recovery had no floor: with few disputes, a run of undisputed
   * purchases dragged the mean threshold from the 0.85 a household chose down
   * to 0.669, and unwanted completions rose 178% against a static mandate.
   * The agent was quietly granting itself more latitude than anyone had given
   * it — through the mechanism meant to reward good behaviour.
   *
   * So the model is: a dispute tightens away from this number, a good streak
   * recovers back toward it, and nothing but the household moves the number
   * itself. See packages/eval.
   */
  baseline_confidence_threshold: z.number().min(0).max(1),
  status: MandateStatus.default("active"),
  history: MandateHistory,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Mandate = z.infer<typeof Mandate>;

/** Convenience factory for creating a fresh mandate with sane defaults. */
export function newMandate(
  input: Pick<
    Mandate,
    "mandate_id" | "goal" | "constraints" | "requires_approval_if" | "authority_type"
  > & { confidence_threshold?: number }
): Mandate {
  const now = new Date().toISOString();
  const threshold = input.confidence_threshold ?? 0.85;
  return Mandate.parse({
    ...input,
    confidence_threshold: threshold,
    // The household's number starts as both the current value and the floor.
    baseline_confidence_threshold: threshold,
    status: "active",
    history: { undisputed_actions: 0, disputed_actions: 0, last_adjusted: null },
    created_at: now,
    updated_at: now,
  });
}
