import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { newMandate } from "@vouch/shared";
import type { Vouch } from "@vouch/shared";
import { VouchStore } from "@vouch/db";

/**
 * Persistence tests focus on the two things that would quietly corrupt the
 * demo's central claim: a dispute that moves a threshold without leaving a
 * record (or vice versa), and a stored document that drifts from its
 * extracted columns.
 */

function seedMandate(store: VouchStore, threshold = 0.85) {
  return store.saveMandate(
    newMandate({
      mandate_id: "m_detergent",
      goal: "Keep laundry detergent stocked",
      constraints: { max_price: 15, preferred_brand: "Brand A" },
      requires_approval_if: ["price > max_price"],
      authority_type: "explicit",
      confidence_threshold: threshold,
    })
  );
}

function seedVouch(store: VouchStore, vouchId = "v1"): Vouch {
  return store.saveVouch({
    vouch_id: vouchId,
    created_at: new Date().toISOString(),
    intent: "Keep laundry detergent stocked",
    authority: { mandate_id: "m_detergent", within_bounds: true, triggered_rules: [] },
    decision: { product: "Brand A Detergent", price: 12.49, reason: ["price_drop"] },
    action: { ucp_session_id: "sess_1", status: "Complete" },
    evidence: {
      digital: { order_id: "order_1", timestamp: new Date().toISOString(), payment_token_ref: null },
      physical: { ring_event_id: null, correlation_status: "unconfirmed" },
    },
    confidence: "high",
    user_controls: ["explain", "dispute"],
    dispute: null,
  });
}

describe("round-tripping", () => {
  it("returns a mandate through the Zod schema, not as a raw row", () => {
    const store = VouchStore.open();
    const saved = seedMandate(store);

    const loaded = store.getMandate("m_detergent");
    assert.deepEqual(loaded, saved);
    assert.equal(loaded?.history.undisputed_actions, 0);
    store.close();
  });

  it("upserts rather than duplicating on a second save", () => {
    const store = VouchStore.open();
    const saved = seedMandate(store);
    store.saveMandate({ ...saved, status: "paused", updated_at: new Date().toISOString() });

    assert.equal(store.listMandates().length, 1);
    assert.equal(store.getMandate("m_detergent")?.status, "paused");
    store.close();
  });

  it("orders vouches newest first and filters by mandate", () => {
    const store = VouchStore.open();
    seedMandate(store);
    const older = seedVouch(store, "v_old");
    const newer = {
      ...older,
      vouch_id: "v_new",
      created_at: new Date(Date.parse(older.created_at) + 60_000).toISOString(),
    };
    store.saveVouch(newer);

    const listed = store.listVouches({ mandate_id: "m_detergent" });
    assert.deepEqual(
      listed.map((v) => v.vouch_id),
      ["v_new", "v_old"]
    );
    assert.equal(store.listVouches({ mandate_id: "nope" }).length, 0);
    store.close();
  });
});

describe("recordDispute writes the record and the adjustment together", () => {
  it("tightens the mandate, stamps the vouch and logs the before/after", () => {
    const store = VouchStore.open();
    seedMandate(store, 0.85);
    seedVouch(store);

    const result = store.recordDispute({
      vouch_id: "v1",
      reason: "I didn't want that",
      newThreshold: 0.92,
      delta: 0.07,
    });

    assert.equal(result.change.threshold_before, 0.85);
    assert.equal(result.change.threshold_after, 0.92);
    assert.equal(store.getMandate("m_detergent")?.confidence_threshold, 0.92);
    assert.equal(store.getMandate("m_detergent")?.history.disputed_actions, 1);

    const vouch = store.getVouch("v1");
    assert.equal(vouch?.dispute?.reason, "I didn't want that");
    assert.equal(vouch?.dispute?.confidence_threshold_delta, 0.07);

    const [logged] = store.listDisputes("m_detergent");
    assert.equal(logged?.threshold_before, 0.85);
    assert.equal(logged?.threshold_after, 0.92);
    store.close();
  });

  it("refuses to dispute the same vouch twice, so one complaint tightens once", () => {
    const store = VouchStore.open();
    seedMandate(store);
    seedVouch(store);
    store.recordDispute({ vouch_id: "v1", newThreshold: 0.92, delta: 0.07 });

    assert.throws(
      () => store.recordDispute({ vouch_id: "v1", newThreshold: 0.99, delta: 0.07 }),
      /already disputed/
    );
    assert.equal(store.getMandate("m_detergent")?.confidence_threshold, 0.92);
    store.close();
  });

  it("leaves nothing behind when the transaction fails", () => {
    const store = VouchStore.open();
    seedMandate(store);

    // No such vouch: the whole operation must roll back, not half-apply.
    assert.throws(() => store.recordDispute({ vouch_id: "missing", newThreshold: 0.92, delta: 0.07 }));

    assert.equal(store.getMandate("m_detergent")?.confidence_threshold, 0.85);
    assert.equal(store.getMandate("m_detergent")?.history.disputed_actions, 0);
    assert.equal(store.listDisputes().length, 0);
    store.close();
  });
});

describe("undisputed actions", () => {
  it("counts the streak and moves the threshold back", () => {
    const store = VouchStore.open();
    seedMandate(store, 0.92);

    const change = store.applyUndisputedAction({ mandate_id: "m_detergent", newThreshold: 0.9 });

    assert.equal(change.threshold_before, 0.92);
    assert.equal(change.threshold_after, 0.9);
    assert.equal(store.getMandate("m_detergent")?.history.undisputed_actions, 1);
    store.close();
  });
});
