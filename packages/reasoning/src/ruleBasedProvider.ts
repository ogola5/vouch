import type {
  ExplainVouchInput,
  ReasoningProvider,
  ThresholdAdjustment,
  ThresholdAdjustmentInput,
} from "./types.ts";

const MIN_THRESHOLD = 0.5;
const MAX_THRESHOLD = 0.99;

/**
 * Default tuning. These are overridable so packages/eval can sweep them —
 * the numbers were originally picked by intuition, and intuition turned out
 * to be wrong: at +0.07 per dispute against a 3-action recovery, a trial of
 * 12,000 decisions ratcheted the mean threshold to 0.951 and held 47% more
 * wanted purchases than a static mandate. An agent that careful is not
 * trustworthy, it is just switched off. See packages/eval/README.md.
 */
export const DEFAULT_TUNING = {
  /**
   * Changed from 0.07 to 0.03 on evidence, 2026-09-23.
   *
   * 0.07 was picked by intuition and measured badly: across 12,000 decisions
   * it cut unwanted purchases by 76.8% but held 2,823 extra wanted ones,
   * ratcheting the mean threshold to 0.957 and leaving the agent completing
   * just 31.3% of the purchases a household actually wanted. An agent that
   * careful is not trustworthy, it is switched off — and a product that
   * blocks two thirds of what you asked for has solved the wrong problem.
   *
   * 0.03 with a shorter recovery sits at 32.0% harm cut for 51.5% usefulness.
   * There is no setting that gets both; the frontier is published in
   * packages/eval/README.md so the choice can be argued with rather than
   * taken on trust. A household that has been burned may well want 0.07, and
   * the constructor takes it.
   */
  disputeTightenStep: 0.03,
  streakLoosenStep: 0.02,
  /** Widen after every N consecutive undisputed actions. */
  streakLoosenEvery: 2,
} as const;

export interface RuleBasedTuning {
  disputeTightenStep?: number;
  streakLoosenStep?: number;
  streakLoosenEvery?: number;
}

/**
 * Thresholds are held to 4 decimal places as well as clamped.
 *
 * Without the rounding, repeated steps accumulate binary floating-point
 * error: 0.85 + 0.07 is 0.9199999999999999, and a few more adjustments make
 * it worse. That is harmless for the gate's comparison but not for
 * everything downstream — the value is persisted, returned over MCP, and
 * shown on the household's Fire TV surface as the mandate's before/after
 * state. "Your threshold is now 0.9199999999999999" undercuts the one screen
 * the whole demo is built to land. 4 places is far finer than the 0.02
 * smallest step, so it changes no decision.
 */
function clamp(value: number): number {
  const bounded = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, value));
  return Math.round(bounded * 10_000) / 10_000;
}

/**
 * No-LLM stand-in for ReasoningProvider. Deliberately simple and
 * deterministic so the adaptive-loop demo (brief section 8, step 5) is
 * reproducible on stage without depending on a model call. Swap for
 * BedrockReasoningProvider once AWS access is set up — same interface.
 */
export class RuleBasedReasoningProvider implements ReasoningProvider {
  private readonly tuning: Required<RuleBasedTuning>;

  constructor(tuning: RuleBasedTuning = {}) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
  }

  async explainVouch({ vouch, mandate }: ExplainVouchInput): Promise<string> {
    const { decision, authority, evidence } = vouch;
    const reasons = decision.reason.join(", ");

    if (vouch.action.status === "PendingApproval") {
      const rules = authority.triggered_rules.join(", ") || "a mandate boundary";
      return `I stopped before buying ${decision.product} at $${decision.price.toFixed(2)} because it would have crossed ${rules} on "${mandate.goal}". I'm waiting for your approval.`;
    }

    const physical =
      evidence.physical.correlation_status === "corroborated"
        ? " Ring picked up the delivery arriving."
        : evidence.physical.correlation_status === "unconfirmed"
          ? " I don't have a Ring delivery confirmation for it yet."
          : "";

    return `I bought ${decision.product} for $${decision.price.toFixed(2)} because ${reasons}, which was within the "${mandate.goal}" mandate.${physical}`;
  }

  async adjustConfidenceThreshold({
    mandate,
    event,
  }: ThresholdAdjustmentInput): Promise<ThresholdAdjustment> {
    const current = mandate.confidence_threshold;

    if (event.kind === "dispute") {
      const next = clamp(current + this.tuning.disputeTightenStep);
      return {
        newThreshold: next,
        delta: next - current,
        rationale: `You disputed a "${mandate.goal}" purchase, so I'll be more conservative on this category from now on (confidence threshold ${current.toFixed(2)} -> ${next.toFixed(2)}).`,
      };
    }

    if (event.streakLength > 0 && event.streakLength % this.tuning.streakLoosenEvery === 0) {
      // Recovery returns TOWARD the household's own number and stops there.
      // Without this floor the loop hands the agent more latitude than anyone
      // granted it — measured, not hypothetical: see packages/eval, where an
      // unfloored recovery drifted a chosen 0.85 down to 0.669 and made
      // unwanted purchases 178% more common than a static mandate.
      const floor = Math.max(MIN_THRESHOLD, mandate.baseline_confidence_threshold);
      const next = clamp(Math.max(floor, current - this.tuning.streakLoosenStep));
      return {
        newThreshold: next,
        delta: next - current,
        rationale: `${event.streakLength} undisputed "${mandate.goal}" purchases in a row, so I'll loosen up slightly (confidence threshold ${current.toFixed(2)} -> ${next.toFixed(2)}).`,
      };
    }

    return {
      newThreshold: current,
      delta: 0,
      rationale: "No adjustment yet.",
    };
  }
}
