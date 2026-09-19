import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

// Workspace names, not relative paths into src/.
//
// REVERSED IN WEEK 2, and worth recording why rather than quietly changing:
// week 1 used relative source imports to keep `npm test` build-free, which
// worked only because every intra-package import in the files under test
// happened to be `import type` and was erased before Node saw it. Week 2's
// packages have real value imports between their own files (store.ts ->
// schema.js, merchant.ts -> catalog.js), and Node's type stripping does not
// rewrite a ".js" specifier to a ".ts" file, so loading src/*.ts directly
// now fails at runtime. Importing the built package is the fix, `npm test`
// runs `tsc -b` first, and --enable-source-maps keeps failures pointing at
// TypeScript line numbers.
import { BELOW_CONFIDENCE_THRESHOLD, evaluateProposal, newMandate } from "@vouch/shared";
import type { Mandate, PurchaseProposal } from "@vouch/shared";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import type { ThresholdAdjustment } from "@vouch/reasoning";

/**
 * The adaptive loop is what makes Vouch this idea rather than a generic
 * permission system: a dispute doesn't just get logged, it changes what
 * the agent is allowed to do next time. That claim is only true if the
 * whole chain holds — dispute -> new threshold -> DIFFERENT GATE OUTCOME
 * on a proposal that previously passed. Testing the middle link alone
 * (that the number moved) would prove nothing; these tests assert the
 * end-to-end behaviour change, which is the thing the demo narrates.
 */

const provider = new RuleBasedReasoningProvider();

function detergentMandate(confidence_threshold = 0.85): Mandate {
  return newMandate({
    mandate_id: "m_detergent",
    goal: "Keep laundry detergent stocked",
    constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
    requires_approval_if: ["price > max_price", "new_brand"],
    authority_type: "explicit",
    confidence_threshold,
  });
}

/** A purchase that is comfortably inside every constraint EXCEPT that its
 *  confidence sits just above the starting threshold — i.e. exactly the
 *  kind of borderline call a dispute should later stop. */
function borderlineProposal(overrides: Partial<PurchaseProposal> = {}): PurchaseProposal {
  return { price: 12.49, quantity: 1, brand: "Brand A", confidence: 0.86, ...overrides };
}

function applyAdjustment(mandate: Mandate, adjustment: ThresholdAdjustment): Mandate {
  return { ...mandate, confidence_threshold: adjustment.newThreshold };
}

describe("adaptive loop — a dispute changes the next decision", () => {
  it("passes a borderline purchase before any dispute", () => {
    const result = evaluateProposal(detergentMandate(), borderlineProposal());

    assert.equal(result.withinBounds, true);
  });

  it("holds that same purchase after a dispute", async () => {
    const before = detergentMandate();
    assert.equal(evaluateProposal(before, borderlineProposal()).withinBounds, true);

    const adjustment = await provider.adjustConfidenceThreshold({
      mandate: before,
      event: { kind: "dispute", reason: "I didn't want this brand" },
    });
    const after = applyAdjustment(before, adjustment);

    assert.ok(adjustment.delta > 0, "a dispute must tighten, not loosen");
    assert.ok(
      after.confidence_threshold > before.confidence_threshold,
      "the mandate's threshold must actually move"
    );

    const result = evaluateProposal(after, borderlineProposal());

    assert.equal(
      result.withinBounds,
      false,
      "the whole point: the identical proposal is now held for approval"
    );
    assert.deepEqual(result.triggeredRules, [BELOW_CONFIDENCE_THRESHOLD]);
  });

  it("explains the adjustment in language a household would understand", async () => {
    const mandate = detergentMandate();

    const adjustment = await provider.adjustConfidenceThreshold({
      mandate,
      event: { kind: "dispute" },
    });

    assert.ok(adjustment.rationale.includes(mandate.goal), "names the mandate it changed");
    assert.ok(/0\.85/.test(adjustment.rationale), "shows the before value");
    assert.ok(/0\.92/.test(adjustment.rationale), "shows the after value");
  });

  it("leaves a purchase that was never near the boundary unaffected", async () => {
    const before = detergentMandate();
    const adjustment = await provider.adjustConfidenceThreshold({
      mandate: before,
      event: { kind: "dispute" },
    });
    const after = applyAdjustment(before, adjustment);

    assert.equal(
      evaluateProposal(after, borderlineProposal({ confidence: 0.99 })).withinBounds,
      true,
      "tightening must not block everything — only the borderline cases"
    );
  });
});

describe("adaptive loop — recovery after undisputed actions", () => {
  it("does not loosen until a full streak is reached", async () => {
    const mandate = detergentMandate(0.92);

    for (const streakLength of [1, 2]) {
      const adjustment = await provider.adjustConfidenceThreshold({
        mandate,
        event: { kind: "undisputed_streak", streakLength },
      });
      assert.equal(adjustment.delta, 0, `streak of ${streakLength} should not move the threshold`);
    }
  });

  it("loosens on a completed streak", async () => {
    const mandate = detergentMandate(0.92);

    const adjustment = await provider.adjustConfidenceThreshold({
      mandate,
      event: { kind: "undisputed_streak", streakLength: 3 },
    });

    assert.ok(adjustment.delta < 0, "an undisputed streak must loosen");
    assert.equal(adjustment.newThreshold, 0.9);
  });

  it("recovers more slowly than it tightens — trust is easier to lose than regain", async () => {
    const start = detergentMandate();

    const disputed = applyAdjustment(
      start,
      await provider.adjustConfidenceThreshold({ mandate: start, event: { kind: "dispute" } })
    );

    let recovering = disputed;
    let streaks = 0;
    while (recovering.confidence_threshold > start.confidence_threshold && streaks < 20) {
      streaks += 1;
      recovering = applyAdjustment(
        recovering,
        await provider.adjustConfidenceThreshold({
          mandate: recovering,
          event: { kind: "undisputed_streak", streakLength: 3 },
        })
      );
    }

    assert.equal(
      streaks,
      4,
      "one dispute (+0.07) takes four undisputed streaks (-0.02 each) to undo"
    );
    assert.equal(
      evaluateProposal(recovering, borderlineProposal()).withinBounds,
      true,
      "and once recovered, the borderline purchase is allowed again"
    );
  });
});

describe("adaptive loop — the threshold stays in a usable range", () => {
  it("never tightens past the ceiling, however many disputes arrive", async () => {
    let mandate = detergentMandate();

    for (let i = 0; i < 25; i += 1) {
      mandate = applyAdjustment(
        mandate,
        await provider.adjustConfidenceThreshold({ mandate, event: { kind: "dispute" } })
      );
    }

    assert.equal(mandate.confidence_threshold, 0.99);
    assert.ok(
      evaluateProposal(mandate, borderlineProposal({ confidence: 1 })).withinBounds,
      "a fully-confident proposal must still be possible — the mandate can never become unusable"
    );
  });

  it("never loosens past the floor, however long the good streak", async () => {
    let mandate = detergentMandate();

    for (let i = 0; i < 40; i += 1) {
      mandate = applyAdjustment(
        mandate,
        await provider.adjustConfidenceThreshold({
          mandate,
          event: { kind: "undisputed_streak", streakLength: 3 },
        })
      );
    }

    assert.equal(mandate.confidence_threshold, 0.5);
    assert.equal(
      evaluateProposal(mandate, borderlineProposal({ confidence: 0.49 })).withinBounds,
      false,
      "even at the floor the threshold still gates something — it never becomes a no-op"
    );
  });
});
