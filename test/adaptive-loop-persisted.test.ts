import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Package names rather than paths into each package's src/, so every class
// here has the single identity the shipped code uses. See the note at the
// top of packages/mcp-server/test/gate-before-complete.test.ts.
import { VouchStore } from "@vouch/db";
import { Merchant } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { VouchService } from "@vouch/mcp-server";
import type { MerchantClient, ProposePurchaseInput } from "@vouch/mcp-server";

/**
 * test/adaptive-loop.test.ts already pins the adjustment arithmetic in
 * isolation. This file is the other half of that claim: the same loop run
 * through the real gate, a real UCP session lifecycle and real persistence,
 * so that "a dispute changes what the agent may do next" is demonstrated
 * end to end rather than only in the pure function.
 *
 * It is written to mirror step 5 of the brief's demo script — the moment the
 * whole submission is built around — so that if the demo would break, this
 * breaks first.
 */

/** The merchant, used directly as a client; no network in this test. */
function directClient(merchant: Merchant): MerchantClient {
  return {
    createSession: async (r) => merchant.createSession(r),
    updateSession: async (id, r) => merchant.updateSession(id, r),
    completeSession: async (id) => merchant.completeSession(id),
    cancelSession: async (id) => merchant.cancelSession(id),
  };
}

function rig(store = VouchStore.open()) {
  const merchant = new Merchant();
  const service = new VouchService({
    store,
    merchant: directClient(merchant),
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
  return { service, merchant, store };
}

/** A borderline call: comfortably in-bounds on price, marginal on confidence. */
const BORDERLINE: ProposePurchaseInput = {
  mandate_id: "m_detergent",
  product_id: "detergent-brand-b",
  quantity: 1,
  brand: "Brand B",
  confidence: 0.88,
  reason: ["price_drop", "fallback_brand"],
};

describe("the adaptive loop, end to end", () => {
  it("lets a borderline purchase through, then holds the identical one after a dispute", async () => {
    const { service, store } = rig();

    // 1. The borderline call passes at the starting threshold of 0.85.
    const first = await service.proposePurchase({ ...BORDERLINE });
    assert.equal(first.outcome, "completed");
    assert.equal(store.getMandate("m_detergent")?.confidence_threshold, 0.85);

    // 2. The household disputes it.
    const dispute = await service.recordDispute({
      vouch_id: first.vouch.vouch_id,
      reason: "I didn't want that brand",
    });
    assert.equal(dispute.threshold_before, 0.85);
    assert.equal(dispute.threshold_after, 0.92);

    // 3. The SAME proposal — same product, same price, same confidence — is
    //    now held. Nothing about the purchase changed; the agent's authority
    //    did. This is the demo's best moment, asserted.
    const second = await service.proposePurchase({ ...BORDERLINE });
    assert.equal(second.outcome, "held_for_approval");
    assert.deepEqual(second.vouch.authority.triggered_rules, ["below_confidence_threshold"]);
    assert.equal(second.vouch.decision.price, first.vouch.decision.price);

    store.close();
  });

  it("explains the change in language a household would accept", async () => {
    const { service, store } = rig();

    const first = await service.proposePurchase({ ...BORDERLINE });
    const dispute = await service.recordDispute({ vouch_id: first.vouch.vouch_id });

    assert.match(dispute.rationale, /more conservative/i);
    assert.match(dispute.rationale, /0\.85 -> 0\.92/);

    const held = await service.proposePurchase({ ...BORDERLINE });
    const explanation = await service.explainVouch(held.vouch.vouch_id);
    assert.match(explanation, /stopped before buying/i);
    assert.match(explanation, /below_confidence_threshold/);

    store.close();
  });

  it("keeps the disputed action in the household's record rather than deleting it", async () => {
    const { service, store } = rig();

    const first = await service.proposePurchase({ ...BORDERLINE });
    await service.recordDispute({ vouch_id: first.vouch.vouch_id, reason: "wrong brand" });

    const vouches = service.listVouches({ mandate_id: "m_detergent" });
    assert.equal(vouches.length, 1);
    assert.equal(vouches[0]?.action.status, "Complete");
    assert.equal(vouches[0]?.dispute?.reason, "wrong brand");

    store.close();
  });
});

describe("the tightened threshold survives a restart", () => {
  it("reloads the adjusted mandate from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vouch-test-"));
    const dbPath = join(dir, "vouch.db");

    try {
      const first = rig(VouchStore.open(dbPath));
      const purchase = await first.service.proposePurchase({ ...BORDERLINE });
      await first.service.recordDispute({ vouch_id: purchase.vouch.vouch_id });
      first.store.close();

      // A fresh process would see this: the demo has to survive the gap
      // between recording segments, so the adjustment cannot live in memory.
      const reopened = VouchStore.open(dbPath);
      assert.equal(reopened.getMandate("m_detergent")?.confidence_threshold, 0.92);
      assert.equal(reopened.getMandate("m_detergent")?.history.disputed_actions, 1);
      assert.equal(reopened.listVouches().length, 1);
      assert.equal(reopened.listDisputes("m_detergent").length, 1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
