import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  RingEvent,
  RingMotionClassification,
  RingWebhookPayload,
} from "./types.ts";

/**
 * Verifying and parsing a Ring webhook delivery.
 *
 * Separated from the provider because signature verification is the one piece
 * here that is security-relevant, and security code that can only be tested
 * by standing up a server tends not to be tested.
 */

export type SignatureResult =
  | { valid: true }
  | { valid: false; reason: "no_secret" | "missing_header" | "malformed" | "mismatch" };

/**
 * HMAC-SHA256 over the RAW request body, compared against `sha256=<hex>`.
 *
 * TAKES THE RAW STRING, AND MUST. Re-serialising a parsed body changes key
 * order and whitespace, so the digest changes with it and verification fails
 * for every genuine delivery — a failure that looks like Ring sending bad
 * signatures rather than like our bug. Callers have to hold the bytes as
 * received; `parseRingWebhook` below takes the same string for that reason.
 *
 * Compared with timingSafeEqual rather than `===`. The practical risk of a
 * timing oracle on a webhook is low, but a constant-time compare costs
 * nothing and this is the function a reviewer will look at first.
 */
export function verifyRingSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string | undefined
): SignatureResult {
  if (!secret) return { valid: false, reason: "no_secret" };
  if (!signatureHeader) return { valid: false, reason: "missing_header" };

  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  if (!/^[0-9a-f]+$/i.test(provided) || provided.length % 2 !== 0) {
    return { valid: false, reason: "malformed" };
  }

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");

  // Length is checked first because timingSafeEqual throws on a mismatch
  // rather than returning false, and a thrown error here would be reported as
  // a server fault instead of a rejected delivery.
  if (a.length !== b.length) return { valid: false, reason: "mismatch" };
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: "mismatch" };
}

const KNOWN_CLASSIFICATIONS = new Set<RingMotionClassification>([
  "human",
  "animal",
  "vehicle",
  "other",
]);

function classify(subType: unknown): RingMotionClassification | null {
  if (typeof subType !== "string") return null;
  const value = subType.toLowerCase();
  // An unrecognised classification becomes "other", never null and never
  // silently "human": the whole point of carrying this field is that a
  // vehicle must not be mistaken for a person at the door.
  return KNOWN_CLASSIFICATIONS.has(value as RingMotionClassification)
    ? (value as RingMotionClassification)
    : "other";
}

export class RingWebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RingWebhookParseError";
  }
}

/**
 * Parses a verified delivery into the shape the correlator searches.
 *
 * Deliberately tolerant about `data.type`: an event type we have never seen
 * is stored rather than rejected. Refusing unknown events would mean a new
 * Ring event type silently emptying the evidence store, and an empty store
 * reports "unconfirmed" — which reads as "no delivery" rather than as
 * "the integration broke".
 */
export function parseRingWebhook(rawBody: string, receivedAt = new Date()): RingEvent {
  let payload: RingWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RingWebhookPayload;
  } catch (error) {
    throw new RingWebhookParseError(
      `body is not JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!payload?.data || typeof payload.data.type !== "string") {
    throw new RingWebhookParseError("expected { meta, data: { type, id } }");
  }

  const attributes = payload.data.attributes ?? {};
  return {
    event_id: payload.data.id ?? "",
    request_id: payload.meta?.request_id ?? "",
    type: payload.data.type,
    device_id: typeof attributes.device_id === "string" ? attributes.device_id : null,
    classification: classify(attributes.sub_type),
    occurred_at: typeof payload.meta?.time === "string" ? payload.meta.time : null,
    received_at: receivedAt.toISOString(),
  };
}
