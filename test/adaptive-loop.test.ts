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
    assert.ok(
      adjustment.rationale.includes(adjustment.newThreshold.toFixed(2)),
      "shows the after value — read from the adjustment rather than hardcoded, so " +
        "retuning the loop on evidence does not silently break an unrelated test"
    );
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
  /**
   * A mandate the household set at 0.85 that a dispute has since pushed to
   * 0.92. Recovery only has anywhere to go when the current threshold sits
   * ABOVE the baseline, which is the state these tests need.
   */
  function tightenedMandate(): Mandate {
    return { ...detergentMandate(0.85), confidence_threshold: 0.92 };
  }

  // Explicit tuning rather than the shipped default. These tests are about
  // the SHAPE of the mechanism — partial streaks do nothing, full ones
  // loosen, recovery is slower than tightening — and pinning them to whatever
  // the default happens to be today made nine tests fail the moment the
  // default was changed on evidence. The default's value is a product
  // decision measured in packages/eval, not a fact about the algorithm.
  const tuned = new RuleBasedReasoningProvider({
    disputeTightenStep: 0.08,
    streakLoosenStep: 0.02,
    streakLoosenEvery: 3,
  });

  it("does not loosen until a full streak is reached", async () => {
    const mandate = tightenedMandate();

    for (const streakLength of [1, 2]) {
      const adjustment = await tuned.adjustConfidenceThreshold({
        mandate,
        event: { kind: "undisputed_streak", streakLength },
      });
      assert.equal(adjustment.delta, 0, `streak of ${streakLength} should not move the threshold`);
    }
  });

  it("loosens on a completed streak", async () => {
    const adjustment = await tuned.adjustConfidenceThreshold({
      mandate: tightenedMandate(),
      event: { kind: "undisputed_streak", streakLength: 3 },
    });

    assert.ok(adjustment.delta < 0, "an undisputed streak must loosen");
    assert.equal(adjustment.newThreshold, 0.9);
  });

  it("recovers more slowly than it tightens — trust is easier to lose than regain", async () => {
    const start = detergentMandate();

    const disputed = applyAdjustment(
      start,
      await tuned.adjustConfidenceThreshold({ mandate: start, event: { kind: "dispute" } })
    );

    let recovering = disputed;
    let streaks = 0;
    while (recovering.confidence_threshold > start.confidence_threshold && streaks < 20) {
      streaks += 1;
      recovering = applyAdjustment(
        recovering,
        await tuned.adjustConfidenceThreshold({
          mandate: recovering,
          event: { kind: "undisputed_streak", streakLength: 3 },
        })
      );
    }

    // The asymmetry itself is the claim, not the exact count: one complaint
    // must cost several good runs to undo.
    assert.ok(streaks >= 4, `recovery should take several streaks, took ${streaks}`);
    assert.ok(streaks < 20, "but it must actually recover, not ratchet forever");
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

  it("never loosens below the threshold the household actually set", async () => {
    /*
     * The strongest guarantee in the loop, and it was missing until a
     * 12,000-decision trial found it (packages/eval). Recovery used to have
     * no floor but the hard minimum of 0.5, so a long run of good purchases
     * dragged a household's chosen 0.85 down to 0.669 — the agent widening
     * its own authority through the mechanism meant to reward it, which
     * breaks the rule that nothing an agent does may increase what it is
     * allowed to do.
     *
     * Now recovery returns toward the household's number and stops dead.
     */
    let mandate = detergentMandate(0.85);
    assert.equal(mandate.baseline_confidence_threshold, 0.85);

    for (let i = 0; i < 40; i += 1) {
      mandate = applyAdjustment(
        mandate,
        await provider.adjustConfidenceThreshold({
          mandate,
          event: { kind: "undisputed_streak", streakLength: 2 },
        })
      );
    }

    assert.equal(
      mandate.confidence_threshold,
      0.85,
      "forty good streaks must not buy the agent one point of extra latitude"
    );
  });

  it("returns exactly to the household's number after a dispute is worked off", async () => {
    const start = detergentMandate(0.85);
    let mandate = applyAdjustment(
      start,
      await provider.adjustConfidenceThreshold({ mandate: start, event: { kind: "dispute" } })
    );
    assert.ok(mandate.confidence_threshold > 0.85, "a dispute tightens");

    for (let i = 0; i < 40; i += 1) {
      mandate = applyAdjustment(
        mandate,
        await provider.adjustConfidenceThreshold({
          mandate,
          event: { kind: "undisputed_streak", streakLength: 2 },
        })
      );
    }

    // Back to where the household put it, and no further. Recovery is
    // forgiveness, not a bonus.
    assert.equal(mandate.confidence_threshold, 0.85);
  });
});
