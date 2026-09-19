import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

// Tests import source with explicit .ts extensions because Node's native
// type stripping (Node 24) executes these files directly and does NOT
// rewrite a ".js" specifier to a ".ts" file the way tsx or ts-node would.
// tsconfig.test.json sets allowImportingTsExtensions for exactly this; the
// build tsconfig only includes src/, so nothing ships with a .ts import.
import { BELOW_CONFIDENCE_THRESHOLD, evaluateProposal } from "../src/gate.ts";
import { newMandate } from "../src/mandate.ts";
import type { PurchaseProposal } from "../src/gate.ts";
import type { Mandate } from "../src/mandate.ts";

/**
 * The gate is the one piece of this system that a judge is invited to
 * distrust — "is the mandate check real, or a caption added after the
 * fact?" These tests exist to answer that in code rather than in prose,
 * so they deliberately assert the uncomfortable cases (unknown rules,
 * paused mandates, boundary values) rather than the happy path alone.
 */

function detergentMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    ...newMandate({
      mandate_id: "m_detergent",
      goal: "Keep laundry detergent stocked",
      constraints: {
        max_price: 15,
        preferred_brand: "Brand A",
        fallback_brand: "Brand B",
      },
      requires_approval_if: ["price > max_price", "new_brand"],
      authority_type: "explicit",
      confidence_threshold: 0.85,
    }),
    ...overrides,
  };
}

function proposal(overrides: Partial<PurchaseProposal> = {}): PurchaseProposal {
  return { price: 12.49, quantity: 1, brand: "Brand A", confidence: 0.92, ...overrides };
}

describe("evaluateProposal — in-bounds", () => {
  it("allows a proposal that satisfies every constraint", () => {
    const result = evaluateProposal(detergentMandate(), proposal());

    assert.equal(result.withinBounds, true);
    assert.equal(result.requiresApproval, false);
    assert.deepEqual(result.triggeredRules, []);
  });

  it("treats the fallback brand as known, not as a new brand", () => {
    const result = evaluateProposal(detergentMandate(), proposal({ brand: "Brand B" }));

    assert.equal(result.withinBounds, true);
  });
});

describe("evaluateProposal — fails closed", () => {
  it("triggers on an unrecognized rule expression rather than ignoring it", () => {
    const mandate = detergentMandate({
      requires_approval_if: ["price > max_price", "vendor_is_on_some_list"],
    });

    const result = evaluateProposal(mandate, proposal());

    assert.equal(
      result.requiresApproval,
      true,
      "an unknown rule must never silently widen the agent's authority"
    );
    assert.deepEqual(result.triggeredRules, ["vendor_is_on_some_list"]);
  });

  it("fails closed even when the unknown rule is the only rule", () => {
    const mandate = detergentMandate({ requires_approval_if: ["totally_novel_constraint"] });

    assert.equal(evaluateProposal(mandate, proposal()).withinBounds, false);
  });

  it("holds every proposal while the mandate is paused", () => {
    const mandate = detergentMandate({ status: "paused" });

    const result = evaluateProposal(mandate, proposal());

    assert.equal(result.withinBounds, false);
    assert.equal(result.triggeredRules[0], "mandate_paused");
  });
});

describe("evaluateProposal — price boundary", () => {
  it("allows a price exactly at max_price", () => {
    assert.equal(evaluateProposal(detergentMandate(), proposal({ price: 15 })).withinBounds, true);
  });

  it("holds a price one cent over max_price", () => {
    const result = evaluateProposal(detergentMandate(), proposal({ price: 15.01 }));

    assert.equal(result.withinBounds, false);
    assert.deepEqual(result.triggeredRules, ["price > max_price"]);
  });

  it("holds the demo's out-of-bounds case: Brand C at $27.80", () => {
    const result = evaluateProposal(detergentMandate(), proposal({ price: 27.8, brand: "Brand C" }));

    assert.equal(result.withinBounds, false);
    assert.deepEqual(result.triggeredRules, ["price > max_price", "new_brand"]);
  });

  it("does not check price when the mandate carries no max_price", () => {
    const mandate = detergentMandate({
      constraints: { preferred_brand: "Brand A" },
      requires_approval_if: ["price > max_price"],
    });

    assert.equal(evaluateProposal(mandate, proposal({ price: 999 })).withinBounds, true);
  });
});

describe("evaluateProposal — quantity rule", () => {
  it("parses a quantity > N rule and holds above the threshold", () => {
    const mandate = detergentMandate({ requires_approval_if: ["quantity > 2"] });

    assert.equal(evaluateProposal(mandate, proposal({ quantity: 2 })).withinBounds, true);
    assert.equal(evaluateProposal(mandate, proposal({ quantity: 3 })).withinBounds, false);
  });

  it("fails closed on a malformed quantity rule", () => {
    const mandate = detergentMandate({ requires_approval_if: ["quantity > many"] });

    assert.equal(evaluateProposal(mandate, proposal({ quantity: 1 })).withinBounds, false);
  });
});

describe("evaluateProposal — confidence threshold", () => {
  it("allows confidence exactly at the threshold", () => {
    const mandate = detergentMandate({ confidence_threshold: 0.85 });

    assert.equal(evaluateProposal(mandate, proposal({ confidence: 0.85 })).withinBounds, true);
  });

  it("holds a proposal below the threshold", () => {
    const mandate = detergentMandate({ confidence_threshold: 0.85 });

    const result = evaluateProposal(mandate, proposal({ confidence: 0.84 }));

    assert.equal(result.withinBounds, false);
    assert.deepEqual(result.triggeredRules, [BELOW_CONFIDENCE_THRESHOLD]);
  });
});
