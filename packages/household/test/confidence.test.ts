import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { evidenceConfidence, gateConfidence } from "@vouch/household";

/**
 * The number the gate compares, built from checkable facts. The tests pin the
 * ORDERING the factors exist to produce, and the one rule that matters most:
 * the agent's own claim can lower the number, never raise it.
 */

const needed = { kind: "forecast" as const, runoutRisk: 0.3, status: "stocked" as const };

describe("evidence confidence", () => {
  it("scores your usual product, at your usual price, when you asked, as certain", () => {
    const c = evidenceConfidence({ need: { kind: "asked" }, product: "usual", priceRatio: 1 });
    assert.equal(c.score, 1);
    assert.equal(c.notes.product, "the product you usually buy");
  });

  it("clears the default 0.85 bar for a usual restock the forecast proposed", () => {
    const c = evidenceConfidence({ need: needed, product: "usual", priceRatio: 1 });
    assert.ok(c.score >= 0.85, `got ${c.score}`);
  });

  it("puts a fallback brand on a forecast just above 0.85 — so one dispute (0.88) holds it", () => {
    // This is the adaptive loop's borderline case, by construction: allowed
    // until the household says it got one wrong, then asked about.
    const c = evidenceConfidence({ need: needed, product: "fallback", priceRatio: null });
    assert.ok(c.score >= 0.85 && c.score < 0.88, `got ${c.score}`);
  });

  it("never lets a brand you did not approve clear the bar", () => {
    const c = evidenceConfidence({ need: { kind: "asked" }, product: "other", priceRatio: 1 });
    assert.ok(c.score < 0.85, `got ${c.score}`);
    assert.match(c.notes.product, /not approved/);
  });

  it("marks down a price well above what you usually pay, and says by how much", () => {
    const c = evidenceConfidence({ need: { kind: "asked" }, product: "usual", priceRatio: 1.3 });
    assert.equal(c.factors.price, 0.75);
    assert.match(c.notes.price, /30% above/);
  });

  it("does not mark down a price drop", () => {
    const c = evidenceConfidence({ need: { kind: "asked" }, product: "usual", priceRatio: 12.49 / 14.99 });
    assert.equal(c.factors.price, 1);
    assert.match(c.notes.price, /17% below/);
  });
});

describe("what the gate compares", () => {
  it("lets the agent admit doubt", () => {
    assert.equal(gateConfidence(0.95, 0.7), 0.7);
  });

  it("never lets the agent manufacture certainty", () => {
    // The whole point: a model claiming 0.99 on a brand you never approved
    // gets the evidence's 0.6, not its own number.
    assert.equal(gateConfidence(0.6, 0.99), 0.6);
  });

  it("uses the evidence alone when there is no claim", () => {
    assert.equal(gateConfidence(0.9, null), 0.9);
  });
});
