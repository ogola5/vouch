import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    authority: {
      mandate_id: "m_detergent",
      within_bounds: true,
      triggered_rules: [],
      confidence_score: 0.92,
      threshold_applied: 0.85,
      checks: null,
      confidence_basis: null,
    },
    decision: { product: "Brand A Detergent", price: 12.49, reason: ["price_drop"] },
    action: { ucp_session_id: "sess_1", status: "Complete" },
    evidence: {
      digital: { order_id: "order_1", timestamp: new Date().toISOString(), payment_token_ref: null },
      physical: {
        ring_event_id: null,
        correlation_status: "unconfirmed",
        event_type: null,
        classification: null,
      },
    },
    confidence: "high",
    user_controls: ["explain", "dispute"],
    dispute: null,
    household: null,
    household_approval: null,
    trace: null,
    failure: null,
  });
}

describe("the tamper-evident record", () => {
  const fileStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "vouch-ledger-")), "ledger.db");
    return { path, store: VouchStore.open(path) };
  };

  it("keeps an unbroken history through honest changes — held, approved, disputed", () => {
    const store = VouchStore.open();
    seedMandate(store);
    const v = seedVouch(store, "v1");
    store.saveVouch({ ...v, confidence: "medium" });
    store.recordDispute({ vouch_id: "v1", reason: "no", newThreshold: 0.88, delta: 0.03 });
    const report = store.verifyLedger();
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.entries, 3, "every write is an entry; nothing is overwritten");
    store.close();
  });

  it("names the entry that was edited", () => {
    const { path, store } = fileStore();
    seedMandate(store);
    seedVouch(store, "v1");
    seedVouch(store, "v2");
    const raw = new DatabaseSync(path);
    const row = raw.prepare("SELECT doc FROM ledger WHERE seq = 1").get() as { doc: string };
    raw.prepare("UPDATE ledger SET doc = ? WHERE seq = 1").run(row.doc.replace("12.49", "1.99"));
    raw.close();
    const report = store.verifyLedger();
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.seq === 1 && /changed after it was written/.test(p.problem)));
    store.close();
  });

  it("notices an entry quietly deleted", () => {
    const { path, store } = fileStore();
    seedMandate(store);
    seedVouch(store, "v1");
    seedVouch(store, "v2");
    seedVouch(store, "v3");
    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM ledger WHERE seq = 2").run();
    raw.close();
    const report = store.verifyLedger();
    assert.ok(report.problems.some((p) => p.seq === 3 && /missing|follow on/.test(p.problem)), JSON.stringify(report.problems));
    store.close();
  });

  it("chains a database from before the record existed — once, and from that point", () => {
    const { path, store } = fileStore();
    seedMandate(store);
    seedVouch(store, "v1");
    store.close();
    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM ledger").run();
    raw.close();

    const reopened = VouchStore.open(path);
    const report = reopened.verifyLedger();
    assert.equal(report.ok, true);
    assert.equal(report.entries, 1);
    reopened.close();
  });
});

describe("records written before the gate's numbers were kept", () => {
  it("still load, with the missing numbers as null rather than a guess", () => {
    // A Vouch is stored as a JSON document, so this is the whole migration
    // story: an old row must parse, and must not pretend to know what the
    // gate compared when it was never written down.
    const path = join(mkdtempSync(join(tmpdir(), "vouch-")), "legacy.db");
    const store = VouchStore.open(path);
    seedMandate(store);
    const saved = seedVouch(store);
    store.close();

    const legacy = structuredClone(saved) as Record<string, any>;
    delete legacy.authority.confidence_score;
    delete legacy.authority.threshold_applied;
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE vouches SET doc = ? WHERE vouch_id = ?").run(JSON.stringify(legacy), saved.vouch_id);
    raw.close();

    const reopened = VouchStore.open(path);
    const loaded = reopened.getVouch(saved.vouch_id);
    assert.equal(loaded?.authority.confidence_score, null);
    assert.equal(loaded?.authority.threshold_applied, null);
    assert.equal(loaded?.decision.price, 12.49);
    reopened.close();
  });
});

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
