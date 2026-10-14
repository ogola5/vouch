import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { VouchStore } from "@vouch/db";
import { Merchant } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { VouchService } from "@vouch/mcp-server";
import type { MerchantClient, ProposePurchaseInput } from "@vouch/mcp-server";

/**
 * S1, "what your no changed": re-checking a purchase against today's mandate
 * must give the SAME answer the real gate would give a real second attempt —
 * otherwise the card on screen would be narration, not evidence. So these
 * tests compare the re-check against an actual proposal, and prove the
 * re-check itself buys nothing and records nothing.
 */

function rig() {
  const merchant = new Merchant();
  let completes = 0;
  const client: MerchantClient = {
    createSession: async (r) => merchant.createSession(r),
    updateSession: async (id, r) => merchant.updateSession(id, r),
    completeSession: async (id) => { completes++; return merchant.completeSession(id); },
    cancelSession: async (id) => merchant.cancelSession(id),
    listProducts: async () => merchant.catalog.list(),
  };
  const store = VouchStore.open();
  const service = new VouchService({
    store,
    merchant: client,
    reasoning: new RuleBasedReasoningProvider(),
    physicalEvidence: new MockRingProvider(),
  });
  service.createMandate({
    mandate_id: "m_detergent",
    goal: "Keep laundry detergent stocked",
    constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
    requires_approval_if: ["price > max_price", "new_brand"],
    authority_type: "explicit",
    confidence_threshold: 0.85,
  });
  return { service, store, completes: () => completes };
}

const BORDERLINE: ProposePurchaseInput = {
  mandate_id: "m_detergent",
  product_id: "detergent-brand-b",
  quantity: 1,
  brand: "Brand B",
  confidence: 0.86,
  reason: ["price_drop", "fallback_brand"],
};

describe("what your no changed", () => {
  it("says a purchase it made would now be held — and matches what the real gate does", async () => {
    const { service, store, completes } = rig();
    const first = await service.proposePurchase({ ...BORDERLINE });
    assert.equal(first.outcome, "completed");
    assert.deepEqual(first.vouch.proposal, { brand: "Brand B", quantity: 1 });

    // Before any dispute, today's answer is the same as then's.
    const unchanged = service.recheckToday(first.vouch.vouch_id);
    assert.equal(unchanged.recheckable, true);
    assert.equal(unchanged.today!.held, false);
    assert.deepEqual(unchanged.changed, []);

    await service.recordDispute({ vouch_id: first.vouch.vouch_id, reason: "I didn't want that" });

    const vouchesBefore = store.listVouches({ limit: 50 }).length;
    const completesBefore = completes();
    const r = service.recheckToday(first.vouch.vouch_id);
    // The re-check is pure: no record, no order.
    assert.equal(store.listVouches({ limit: 50 }).length, vouchesBefore);
    assert.equal(completes(), completesBefore);

    assert.equal(r.then.held, false);
    assert.equal(r.then.threshold, 0.85);
    assert.equal(r.today!.held, true);
    assert.equal(r.today!.threshold, 0.88);
    assert.deepEqual(r.changed.map((c) => [c.rule, c.then, c.today]), [["below_confidence_threshold", true, false]]);

    // And it is the truth: the real gate, given the identical purchase, holds it for the same rule.
    const second = await service.proposePurchase({ ...BORDERLINE });
    assert.equal(second.outcome, "held_for_approval");
    assert.deepEqual(second.vouch.authority.triggered_rules, r.today!.triggered_rules);
    store.close();
  });

  it("refuses to guess about a record that never kept its brand and quantity", async () => {
    const { service, store } = rig();
    const first = await service.proposePurchase({ ...BORDERLINE });
    // A record written before `proposal` existed.
    store.saveVouch({ ...first.vouch, vouch_id: "v_old", proposal: null });
    const r = service.recheckToday("v_old");
    assert.equal(r.recheckable, false);
    assert.match(r.reason ?? "", /can't be re-checked faithfully/);
    assert.equal(r.today, null);
    store.close();
  });
});
