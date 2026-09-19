import type { PhysicalEvidence } from "@vouch/shared";

/**
 * The seam between "simulated doorstep evidence" and "real Ring webhook".
 * You don't have Ring developer portal access yet, so weeks 1-2 (and the
 * early part of week 3) are written against this interface and driven by
 * MockRingProvider (see mockProvider.ts). Once the portal account and
 * ring-api-helloworld fork exist, add a RealRingProvider that subscribes to
 * actual webhook events and swap it in at the composition root
 * (packages/mcp-server) — nothing that calls a PhysicalEvidenceProvider
 * needs to change.
 *
 * CRITICAL HONESTY RULE (brief section 4/9): a provider here may only ever
 * report "corroborated" when it has an actual motion/package-shaped-object
 * event inside the expected delivery window — never claim it as proof a
 * specific order arrived. "unconfirmed" is the honest default when no such
 * event exists yet.
 */

export interface CorrelationRequest {
  order_id: string;
  /** ISO 8601 datetime the delivery was expected around. */
  expected_around: string;
  /** How wide a window (minutes) around expected_around still counts. */
  window_minutes: number;
}

export interface PhysicalEvidenceProvider {
  correlateDelivery(request: CorrelationRequest): Promise<PhysicalEvidence>;
}
