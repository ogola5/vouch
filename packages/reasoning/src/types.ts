import type { Mandate, Vouch } from "@vouch/shared";

/**
 * The seam between "explain/adjust in plain rules" and "explain/adjust with
 * an actual model call". You don't have AWS Bedrock access set up yet, so
 * week 1-2 code is written against this interface and driven by
 * RuleBasedReasoningProvider (see ruleBasedProvider.ts). Once Bedrock
 * access exists, add a BedrockReasoningProvider implementing the same
 * interface and swap it in at the composition root (packages/mcp-server) —
 * nothing that calls a ReasoningProvider needs to change.
 *
 * This also covers the AWS Builder mini-challenge's two asks directly:
 * (a) generating the plain-language Vouch explanation -> explainVouch
 * (b) deciding how much a dispute should tighten a mandate's
 *     confidence_threshold -> adjustConfidenceThreshold
 */

export interface ExplainVouchInput {
  vouch: Vouch;
  mandate: Mandate;
}

export type ThresholdAdjustmentEvent =
  | { kind: "dispute"; reason?: string }
  | { kind: "undisputed_streak"; streakLength: number };

export interface ThresholdAdjustmentInput {
  mandate: Mandate;
  event: ThresholdAdjustmentEvent;
}

export interface ThresholdAdjustment {
  newThreshold: number;
  delta: number;
  /** Plain-language reason for the adjustment, shown on the Fire TV /
   *  dashboard before/after mandate state view. */
  rationale: string;
}

export interface ReasoningProvider {
  explainVouch(input: ExplainVouchInput): Promise<string>;
  adjustConfidenceThreshold(input: ThresholdAdjustmentInput): Promise<ThresholdAdjustment>;
}
