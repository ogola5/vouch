import type { Mandate } from "./mandate.ts";

/**
 * A Vouch mandate, expressed as an AP2 Intent Mandate (BUILD_PLAN.md Q1).
 *
 * AP2 standardizes how an agent proves it was authorized; Vouch is the
 * household's side. This makes the claim checkable: the household's rules,
 * written in the shape AP2 defines — and, separately, what AP2 has no field
 * for.
 *
 * The six fields are AP2's own, verified 2026-10-14 against
 * google-agentic-commerce/AP2, code/sdk/python/ap2/models/mandate.py:
 * natural_language_description, user_cart_confirmation_required, merchants,
 * skus, requires_refundability, intent_expiry. Nothing is added inside the
 * AP2 object; everything Vouch-specific is beside it, in `vouch_extension`,
 * and every mapping decision is written out in `mapping`.
 */

export interface Ap2IntentMandate {
  natural_language_description: string;
  user_cart_confirmation_required: boolean;
  merchants: string[] | null;
  skus: string[] | null;
  requires_refundability: boolean;
  intent_expiry: string;
}

export interface Ap2Export {
  intent_mandate: Ap2IntentMandate;
  /** What the household set that AP2's Intent Mandate has no field for. */
  vouch_extension: {
    mandate_id: string;
    max_price: number | null;
    preferred_brand: string | null;
    fallback_brand: string | null;
    max_quantity: number | null;
    ask_first_when: string[];
    autonomy: Mandate["autonomy"];
    confidence_threshold: number;
    household_threshold: number;
    disputes: number;
  };
  /** How each AP2 field was filled — so the export can be argued with, not trusted. */
  mapping: string[];
}

const RENEWAL_DAYS = 30;

const money = (n: number) => `$${n.toFixed(2)}`;

export function toAp2IntentMandate(mandate: Mandate, now: Date): Ap2Export {
  const c = mandate.constraints;
  const maxPrice = typeof c.max_price === "number" ? c.max_price : null;
  const preferred = typeof c.preferred_brand === "string" ? c.preferred_brand : null;
  const fallback = typeof c.fallback_brand === "string" ? c.fallback_brand : null;
  const quantity = typeof c.quantity === "number" ? c.quantity : null;
  const auto = mandate.autonomy.mode === "auto" && mandate.status !== "paused";

  const askFirst = mandate.requires_approval_if.map((r) =>
    r === "price > max_price" ? "the price is over the limit" : r === "new_brand" ? "it is a brand I haven't approved" : /^quantity/.test(r) ? `more than ${r.match(/\d+/)?.[0]} at once` : r
  );
  const sentences = [
    `${mandate.goal.replace(/\.$/, "")}.`,
    maxPrice !== null ? `Each purchase at most ${money(maxPrice)}.` : null,
    preferred ? `Buy ${preferred}${fallback ? `, or ${fallback} if it is unavailable` : ""}.` : null,
    quantity !== null ? `No more than ${quantity} at a time.` : null,
    askFirst.length ? `Ask me first if ${askFirst.join(", or if ")}.` : null,
    auto ? `You may buy without asking${mandate.autonomy.until ? ` until ${mandate.autonomy.until}` : ""}.` : "Ask me before every purchase.",
  ].filter(Boolean);

  const expiry = mandate.autonomy.until
    ? `${mandate.autonomy.until}T23:59:59Z`
    : new Date(now.getTime() + RENEWAL_DAYS * 86_400_000).toISOString();

  return {
    intent_mandate: {
      natural_language_description: sentences.join(" "),
      user_cart_confirmation_required: !auto,
      merchants: null,
      skus: null,
      requires_refundability: false,
      intent_expiry: expiry,
    },
    vouch_extension: {
      mandate_id: mandate.mandate_id,
      max_price: maxPrice,
      preferred_brand: preferred,
      fallback_brand: fallback,
      max_quantity: quantity,
      ask_first_when: askFirst,
      autonomy: mandate.autonomy,
      confidence_threshold: mandate.confidence_threshold,
      household_threshold: mandate.baseline_confidence_threshold,
      disputes: mandate.history.disputed_actions,
    },
    mapping: [
      "natural_language_description: written from the mandate's goal, price ceiling, brands and ask-first rules. AP2's Intent Mandate has no amount field, so the ceiling can only be stated here — Vouch enforces it in its gate.",
      `user_cart_confirmation_required: ${auto ? "false — the household handed this item over (Auto)" : "true — Ask or Remind, or paused: the household confirms every purchase"}. AP2 requires true unless the user signed; once the household has set up a passkey, Vouch requires it before an item can be handed over.`,
      "merchants: not set — any merchant (Vouch's mandates do not restrict merchants).",
      "skus: not set — Vouch constrains brands, not SKUs; the brands are in the description and in vouch_extension.",
      "requires_refundability: false — Vouch does not track refundability.",
      mandate.autonomy.until
        ? `intent_expiry: the end of the hand-over the household chose (${mandate.autonomy.until}).`
        : `intent_expiry: ${RENEWAL_DAYS} days from now. AP2 requires an expiry and this mandate has none, so it is re-issued as a renewal.`,
      "Not representable in AP2: the confidence threshold a dispute moves, and the dispute history — Vouch's adaptive part. Kept in vouch_extension.",
    ],
  };
}
