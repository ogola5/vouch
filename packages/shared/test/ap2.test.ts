import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Mandate, toAp2IntentMandate } from "@vouch/shared";

/**
 * Q1: a Vouch mandate as an AP2 Intent Mandate. The AP2 object must hold
 * AP2's six fields and nothing else (verified against the AP2 SDK's
 * models/mandate.py, 2026-10-14); Vouch's own parts go beside it.
 */

const NOW = new Date("2026-10-14T10:00:00Z");

function mandate(over: Record<string, unknown> = {}) {
  return Mandate.parse({
    mandate_id: "m_detergent",
    goal: "Keep laundry detergent stocked",
    constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
    requires_approval_if: ["price > max_price", "new_brand"],
    authority_type: "explicit",
    confidence_threshold: 0.88,
    baseline_confidence_threshold: 0.85,
    history: { disputed_actions: 1 },
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  });
}

describe("a mandate as an AP2 Intent Mandate", () => {
  it("uses exactly AP2's six fields — nothing of Vouch's inside the AP2 object", () => {
    const x = toAp2IntentMandate(mandate(), NOW);
    assert.deepEqual(Object.keys(x.intent_mandate).sort(), [
      "intent_expiry",
      "merchants",
      "natural_language_description",
      "requires_refundability",
      "skus",
      "user_cart_confirmation_required",
    ]);
  });

  it("says the household's rules in the description, since AP2 has no price field", () => {
    const d = toAp2IntentMandate(mandate(), NOW).intent_mandate.natural_language_description;
    assert.equal(
      d,
      "Keep laundry detergent stocked. Each purchase at most $15.00. Buy Brand A, or Brand B if it is unavailable. " +
        "Ask me first if the price is over the limit, or if it is a brand I haven't approved. Ask me before every purchase."
    );
  });

  it("requires cart confirmation unless the item is handed over (Auto), and never when paused", () => {
    assert.equal(toAp2IntentMandate(mandate(), NOW).intent_mandate.user_cart_confirmation_required, true);
    const auto = mandate({ autonomy: { mode: "auto", until: "2026-12-13", delivery_days: null } });
    assert.equal(toAp2IntentMandate(auto, NOW).intent_mandate.user_cart_confirmation_required, false);
    const paused = mandate({ autonomy: { mode: "auto", until: null, delivery_days: null }, status: "paused" });
    assert.equal(toAp2IntentMandate(paused, NOW).intent_mandate.user_cart_confirmation_required, true);
  });

  it("expires when the hand-over ends, or is re-issued monthly — AP2 requires an expiry", () => {
    const auto = mandate({ autonomy: { mode: "auto", until: "2026-12-13", delivery_days: null } });
    assert.equal(toAp2IntentMandate(auto, NOW).intent_mandate.intent_expiry, "2026-12-13T23:59:59Z");
    const x = toAp2IntentMandate(mandate(), NOW);
    assert.equal(x.intent_mandate.intent_expiry, "2026-11-13T10:00:00.000Z");
    assert.ok(x.mapping.some((m) => /AP2 requires an expiry and this mandate has none/.test(m)));
  });

  it("keeps what AP2 cannot express beside it — the adaptive part — and says so", () => {
    const x = toAp2IntentMandate(mandate(), NOW);
    assert.equal(x.vouch_extension.max_price, 15);
    assert.equal(x.vouch_extension.confidence_threshold, 0.88);
    assert.equal(x.vouch_extension.household_threshold, 0.85);
    assert.equal(x.vouch_extension.disputes, 1);
    assert.ok(x.mapping.some((m) => /has no amount field/.test(m)));
    assert.ok(x.mapping.some((m) => /Not representable in AP2/.test(m)));
  });
});
