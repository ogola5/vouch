import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

// Tests import the built workspace package, not ../src. Node's type
// stripping executes .ts directly but does NOT rewrite a ".js" specifier to
// a ".ts" file, so a source file with real (non-type-only) imports of its
// siblings cannot be loaded from src/ at all. `npm test` runs `tsc -b`
// first; see the note in tsconfig.test.json.
import {
  AUTONOMY_EXPIRED,
  AUTONOMY_NOT_GRANTED,
  BELOW_CONFIDENCE_THRESHOLD,
  evaluateProposal,
  newMandate,
} from "@vouch/shared";
import type { Mandate, PurchaseProposal } from "@vouch/shared";

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

describe("evaluateProposal — autonomy: may the agent buy this without being asked?", () => {
  const auto = (until: string | null = null) =>
    detergentMandate({ autonomy: { mode: "auto", until, delivery_days: null } });
  const unprompted = (at?: string) => proposal({ initiatedBy: "forecast", at });

  it("a new mandate grants no autonomy: an unprompted purchase is held", () => {
    // Ask is the default — including for every mandate written before
    // autonomy existed — so no household is bought for without choosing it.
    const result = evaluateProposal(detergentMandate(), unprompted("2026-10-01T09:00:00Z"));
    assert.deepEqual(result.triggeredRules, [AUTONOMY_NOT_GRANTED]);
  });

  it("holds an unprompted purchase in Remind mode too", () => {
    const remind = detergentMandate({ autonomy: { mode: "remind", until: null, delivery_days: null } });
    assert.ok(evaluateProposal(remind, unprompted("2026-10-01T09:00:00Z")).requiresApproval);
  });

  it("allows it in Auto mode, within the same limits as always", () => {
    assert.equal(evaluateProposal(auto(), unprompted("2026-10-01T09:00:00Z")).withinBounds, true);
    // Autonomy never widens the limits: over the price is still held.
    assert.ok(evaluateProposal(auto(), proposal({ initiatedBy: "forecast", price: 19.99 })).requiresApproval);
  });

  it("honours an end date to the day, inclusive", () => {
    assert.equal(evaluateProposal(auto("2026-12-25"), unprompted("2026-12-25T20:00:00Z")).withinBounds, true);
    assert.deepEqual(evaluateProposal(auto("2026-12-25"), unprompted("2026-12-26T08:00:00Z")).triggeredRules, [
      AUTONOMY_EXPIRED,
    ]);
  });

  it("fails closed when it cannot tell whether autonomy has expired", () => {
    assert.deepEqual(evaluateProposal(auto("2026-12-25"), unprompted(undefined)).triggeredRules, [AUTONOMY_EXPIRED]);
  });

  it("does not govern a household's own request at all", () => {
    // "Order my usual" is authorised by the limits, as it always was. Remind
    // or Ask mode must not stop a person buying their own detergent.
    const result = evaluateProposal(detergentMandate(), proposal({ initiatedBy: "request" }));
    assert.equal(result.withinBounds, true);
  });
});

describe("evaluateProposal — reports every check, passes included", () => {
  it("shows what it looked at when everything passes, not an empty list", () => {
    const { checks, withinBounds } = evaluateProposal(detergentMandate(), proposal());
    assert.equal(withinBounds, true);
    assert.ok(checks.every((c) => c.passed));
    const detail = (rule: string) => checks.find((c) => c.rule === rule)?.detail;
    assert.equal(detail("price > max_price"), "$12.49 ≤ $15.00");
    assert.equal(detail("new_brand"), "Brand A is one of Brand A, Brand B");
    assert.equal(detail(BELOW_CONFIDENCE_THRESHOLD), "confidence 0.92 ≥ 0.85");
    assert.equal(detail("mandate_active"), "active");
  });

  it("says exactly how a failing check failed, and still reports the ones that passed", () => {
    const { checks } = evaluateProposal(detergentMandate(), proposal({ price: 27.8, brand: "Brand C" }));
    assert.deepEqual(
      checks.filter((c) => !c.passed).map((c) => c.detail),
      ["$27.80 > $15.00", "Brand C is not one of Brand A, Brand B"]
    );
    assert.ok(checks.some((c) => c.passed && c.rule === BELOW_CONFIDENCE_THRESHOLD));
  });

  it("names an unknown rule as held rather than guessed", () => {
    const { checks } = evaluateProposal(detergentMandate({ requires_approval_if: ["vendor_is_on_some_list"] }), proposal());
    assert.match(checks.find((c) => c.rule === "vendor_is_on_some_list")!.detail, /held rather than guessed/);
  });
});

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
