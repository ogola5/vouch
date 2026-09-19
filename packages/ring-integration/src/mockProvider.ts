import type { PhysicalEvidence } from "@vouch/shared";
import type { CorrelationRequest, PhysicalEvidenceProvider } from "./types.js";

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
    return {
      ring_event_id: status === "corroborated" ? `mock-ring-evt-${request.order_id}` : null,
      correlation_status: status,
    };
  }
}
