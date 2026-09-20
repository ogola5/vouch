import type { PhysicalEvidence } from "@vouch/shared";
import type { CorrelationRequest, PhysicalEvidenceProvider } from "./types.ts";

/**
 * Deterministic, scriptable stand-in for a real Ring webhook. Deliberately
 * NOT random: the demo script (brief section 8) needs to reliably show one
 * corroborated and one unconfirmed Vouch on stage, so outcomes are set up
 * ahead of time per order_id rather than left to chance.
 *
 * Usage: mockRingProvider.scriptOutcome(orderId, "corroborated") during
 * demo setup, then the mcp-server's evidence step calls correlateDelivery
 * as normal. Any order_id that wasn't scripted falls back to "unconfirmed"
 * — the same fail-honest default a real provider should use when no event
 * has arrived yet.
 */
export class MockRingProvider implements PhysicalEvidenceProvider {
  private scripted = new Map<string, "corroborated" | "unconfirmed" | "not_applicable">();

  scriptOutcome(orderId: string, outcome: "corroborated" | "unconfirmed" | "not_applicable"): void {
    this.scripted.set(orderId, outcome);
  }

  async correlateDelivery(request: CorrelationRequest): Promise<PhysicalEvidence> {
    const status = this.scripted.get(request.order_id) ?? "unconfirmed";
    const corroborated = status === "corroborated";
    return {
      ring_event_id: corroborated ? `mock-ring-evt-${request.order_id}` : null,
      correlation_status: status,
      // A scripted corroboration stands in for a real motion event, so it
      // carries the same shape a real one would — including the
      // classification, which is what stops a vehicle being mistaken for a
      // person at the door. A simulator that omitted these would make the
      // demo show less than the real provider does, which is the wrong way
      // round for a stand-in.
      event_type: corroborated ? "motion_detected" : null,
      classification: corroborated ? "human" : null,
    };
  }
}
