import type { PhysicalEvidence } from "@vouch/shared";

/**
 * The seam between "simulated doorstep evidence" and "real Ring webhook",
 * plus the wire types for the real one.
 *
 * PROVENANCE, because it decides how far to trust what is below. The Ring
 * webhook types here are written against Ring's **published documentation**,
 * not against a captured delivery. Account linking was not completed — it
 * requires a sign-in and a partner-side user identity this product
 * deliberately does not have (BUILD_PLAN.md §7) — so no real payload has ever
 * reached the receiver.
 *
 * That distinction is recorded rather than glossed because this project has
 * been wrong in exactly this way before: the UCP checkout types were written
 * from prose and were wrong in nearly every particular. So these are marked
 * documented-not-captured, and `scripts/capture.ts` exists to replace them
 * with observed truth the moment a real delivery lands. If one ever does,
 * re-check this file against it before trusting a field.
 *
 * CRITICAL HONESTY RULE (brief §4/§9): a provider here may only report
 * "corroborated" when it holds an actual event inside the expected delivery
 * window — never as proof a specific order arrived. Ring publishes no
 * package-delivered event at all; the list is motion, button press and device
 * lifecycle. "unconfirmed" is the honest default when no such event exists.
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

/* -------------------------------------------------------------------------
 * Ring webhook wire format
 * ---------------------------------------------------------------------- */

/**
 * Event types Ring publishes, recorded in BUILD_PLAN.md §1. The finding that
 * matters is worth restating here where the code can see it: **there is no
 * "package delivered" event.** Package detection is a computer-vision
 * capability, not a webhook you can subscribe to. Anything in this codebase
 * claiming otherwise is a bug.
 */
export const RING_EVENT_TYPES = [
  "motion_detected",
  "button_press",
  "device_added",
  "device_removed",
  "device_online",
  "device_offline",
  "app_integration_added",
  "app_integration_removed",
  "subscription_activated",
  "subscription_deactivated",
] as const;
export type RingEventType = (typeof RING_EVENT_TYPES)[number];

/**
 * What Ring's vision classified the motion as.
 *
 * This is the field BUILD_PLAN.md §1 flagged as missing from the old shape,
 * and the reason holds: without it, a car passing on the street is
 * indistinguishable from a person at the door, and a "corroborated" delivery
 * could rest on a vehicle. It is carried through into the evidence record so
 * the distinction survives into the household's Vouch rather than being
 * flattened at the boundary.
 */
export type RingMotionClassification = "human" | "animal" | "vehicle" | "other";

/** `meta` on every delivery. `request_id` is Ring's idempotency key. */
export interface RingWebhookMeta {
  request_id: string;
  time?: string;
}

export interface RingEventAttributes {
  device_id?: string;
  /** Motion classification — "human" / "animal" / "vehicle". */
  sub_type?: string;
  component_ids?: number[];
  /** Open: the documented examples are not exhaustive and this is unverified. */
  [key: string]: unknown;
}

export interface RingWebhookData {
  /** Left as string, not RingEventType: an unknown event must parse, not throw. */
  type: string;
  id: string;
  attributes?: RingEventAttributes;
}

/** A full delivery body: `{ meta, data }`. */
export interface RingWebhookPayload {
  meta: RingWebhookMeta;
  data: RingWebhookData;
}

/**
 * A delivery after verification and parsing — what the correlator searches.
 *
 * `received_at` is OUR clock and is kept separate from Ring's `meta.time` on
 * purpose. Correlating against a timestamp the sender controls would let a
 * delayed or replayed event land inside a window it never belonged in, and
 * "the doorbell says it happened then" is precisely the claim this project
 * is not willing to make.
 */
export interface RingEvent {
  event_id: string;
  request_id: string;
  type: string;
  device_id: string | null;
  classification: RingMotionClassification | null;
  /** Ring's own timestamp, when it sent one. */
  occurred_at: string | null;
  /** When this receiver accepted it. */
  received_at: string;
}

/** Header carrying the HMAC-SHA256 signature, as `sha256=<hex>`. */
export const RING_SIGNATURE_HEADER = "x-signature";
