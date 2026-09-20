import type { PhysicalEvidence } from "@vouch/shared";
import type {
  CorrelationRequest,
  PhysicalEvidenceProvider,
  RingEvent,
} from "./types.ts";

/**
 * The real Ring integration: a store of verified webhook deliveries, and a
 * correlator that searches it.
 *
 * THE CLAIM THIS MAKES, stated exactly, because the whole submission rests on
 * it being narrow: *Ring gives us an event at the door. We correlate it
 * against the window the order was expected in. That is correlation, not
 * proof.* There is no Ring event meaning "this parcel arrived" — the
 * published list is motion, button press and device lifecycle — so no
 * implementation, however good, can honestly report delivery. Anything here
 * returning a boolean "delivered" would be a bug.
 *
 * WHAT IS REAL AND WHAT IS NOT. The signature verification, the parsing, the
 * store and the time-window correlation are real and tested. What has not
 * happened is a delivery from Ring's servers: completing account linking
 * requires a partner-side sign-in and user identity this product does not
 * have (BUILD_PLAN.md §7). So this is exercised with signed deliveries rather
 * than observed ones, and the README's real-vs-simulated table says so.
 */

/**
 * Holds recent verified events for the correlator to search.
 *
 * In memory, bounded, and deliberately not persisted. A delivery window is
 * minutes wide, so an event older than the longest window is of no use to
 * anyone, and persisting doorstep events would mean this project storing a
 * log of when people came and went — which is the household-surveillance
 * framing the brief's guardrails rule out. Evidence is kept exactly as long
 * as it can be evidence for something.
 */
export class RingEventStore {
  private events: RingEvent[] = [];
  private readonly capacity: number;

  constructor(capacity = 200) {
    this.capacity = capacity;
  }

  add(event: RingEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
  }

  all(): RingEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }

  /**
   * Events whose received time falls inside [centre - window, centre + window].
   *
   * Matched on `received_at` — our clock — not on Ring's `meta.time`.
   * Correlating against a timestamp the sender controls would let a delayed
   * or replayed event land inside a window it never belonged in.
   */
  within(centreIso: string, windowMinutes: number): RingEvent[] {
    const centre = Date.parse(centreIso);
    if (Number.isNaN(centre)) return [];
    const half = Math.max(0, windowMinutes) * 60_000;
    return this.events.filter((event) => {
      const at = Date.parse(event.received_at);
      return !Number.isNaN(at) && Math.abs(at - centre) <= half;
    });
  }
}

/** Events that could plausibly be someone arriving at the door. */
const DOORSTEP_EVENTS = new Set(["motion_detected", "button_press"]);

/**
 * Classifications that corroborate a person at the door.
 *
 * A vehicle passing is motion, and it is not evidence a parcel was dropped.
 * Treating it as corroboration is the specific failure BUILD_PLAN.md §1
 * warned about when it flagged that the old evidence shape could not tell
 * them apart.
 */
const CORROBORATING = new Set(["human", "other", null]);

export interface RealRingProviderOptions {
  store: RingEventStore;
}

export class RealRingProvider implements PhysicalEvidenceProvider {
  readonly store: RingEventStore;

  constructor(options: RealRingProviderOptions) {
    this.store = options.store;
  }

  async correlateDelivery(request: CorrelationRequest): Promise<PhysicalEvidence> {
    const candidates = this.store
      .within(request.expected_around, request.window_minutes)
      .filter((event) => DOORSTEP_EVENTS.has(event.type));

    if (candidates.length === 0) {
      // Honest default. No event in the window is not evidence of absence
      // either — it is simply the absence of evidence, which is what
      // "unconfirmed" means and why it is not called "not_delivered".
      return {
        ring_event_id: null,
        correlation_status: "unconfirmed",
        event_type: null,
        classification: null,
      };
    }

    // A button press beats motion: someone deliberately pressed the doorbell,
    // which is a stronger signal of arrival than something moving nearby.
    const best =
      candidates.find((event) => event.type === "button_press") ??
      candidates.find((event) => CORROBORATING.has(event.classification)) ??
      candidates[0]!;

    const corroborates =
      best.type === "button_press" || CORROBORATING.has(best.classification);

    return {
      ring_event_id: best.event_id || null,
      // A vehicle-only window reports "unconfirmed" WITH the event attached,
      // so the household can see what was seen and judge it. Reporting
      // nothing would hide the evidence; reporting "corroborated" would
      // overstate it.
      correlation_status: corroborates ? "corroborated" : "unconfirmed",
      event_type: best.type,
      classification: best.classification,
    };
  }
}
