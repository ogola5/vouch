import type {
  ExplainVouchInput,
  ReasoningProvider,
  ThresholdAdjustment,
  ThresholdAdjustmentInput,
} from "./types.ts";

const MIN_THRESHOLD = 0.5;
const MAX_THRESHOLD = 0.99;
const DISPUTE_TIGHTEN_STEP = 0.07;
const STREAK_LOOSEN_STEP = 0.02;
const STREAK_LOOSEN_EVERY = 3; // widen after every N consecutive undisputed actions

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
      const next = clamp(current + DISPUTE_TIGHTEN_STEP);
      return {
        newThreshold: next,
        delta: next - current,
        rationale: `You disputed a "${mandate.goal}" purchase, so I'll be more conservative on this category from now on (confidence threshold ${current.toFixed(2)} -> ${next.toFixed(2)}).`,
      };
    }

    if (event.streakLength > 0 && event.streakLength % STREAK_LOOSEN_EVERY === 0) {
      const next = clamp(current - STREAK_LOOSEN_STEP);
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
