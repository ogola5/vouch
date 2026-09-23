import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { DEFAULT_TRIAL, lateHarmReduction, runTrial } from "@vouch/eval";
import type { SweepRow, TrialResult } from "@vouch/eval";

/**
 * Every number published in README.md, re-derived from the committed results.
 *
 * A validation figure that lives only in prose drifts the first time the
 * model changes, and nobody notices until someone checks it on stage. These
 * tests fail instead. They are the reason the README's claims can be read as
 * current rather than as of whenever they were written.
 *
 * They also re-run the trial to confirm the committed results are what the
 * code actually produces — a results file could otherwise be hand-edited into
 * saying anything.
 */

const resultsUrl = new URL("../results/trial.json", import.meta.url);
const sweepUrl = new URL("../results/sweep.json", import.meta.url);

const trial = JSON.parse(readFileSync(resultsUrl, "utf8")) as TrialResult;
const sweep = JSON.parse(readFileSync(sweepUrl, "utf8")) as SweepRow[];

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("the committed results are what the code produces", () => {
  it("reproduces the trial exactly from the same seed", async () => {
    const rerun = await runTrial(DEFAULT_TRIAL);

    // Deterministic, or the published numbers are anecdotes.
    assert.deepEqual(rerun.adaptive, trial.adaptive);
    assert.deepEqual(rerun.static, trial.static);
    assert.deepEqual(rerun.lateHarm, trial.lateHarm);
  });

  it("ran the scale the README claims", () => {
    assert.equal(trial.config.households, 200);
    assert.equal(trial.adaptive.totalOpportunities, 12_000);
    assert.match(README, /12,000 decisions/);
    assert.match(README, new RegExp(String(trial.config.seed)));
  });
});

describe("the README's headline numbers match the data", () => {
  it("headlines the tuning that actually ships, not the flattering one", () => {
    // The trial runs the shipped defaults, so this is the number a reader
    // gets if they run `npm run eval`. Headlining the +0.07 result while
    // shipping +0.03 would be true in isolation and misleading in effect.
    const reduction = lateHarmReduction(trial);
    assert.match(README, new RegExp(`${reduction.toFixed(1)}%`));
    assert.match(README, /The result, at the tuning that ships/);
  });

  it("quotes the cost alongside the win, in the same section", () => {
    // The guardrail this file mostly exists for. A README that published the
    // reduction and quietly dropped the cost would be the exact overclaim
    // this project keeps saying it will not make.
    assert.match(README, new RegExp(`${trial.adaptive.wantedHeld.toLocaleString("en-US")}`));
    assert.match(README, new RegExp(`${trial.static.wantedHeld.toLocaleString("en-US")}`));
    assert.match(README, /what it cost/i);
  });

  it("still reports the rejected +0.07 tuning and why it was rejected", () => {
    const aggressive = sweep.find((row) => row.disputeTightenStep === 0.07);
    assert.ok(aggressive);
    assert.match(README, new RegExp(`${aggressive.harmReduction.toFixed(1)}%`));
    assert.match(README, new RegExp(`${aggressive.wantedCompletionRate.toFixed(1)}%`));
    assert.match(README, /not a good product/i);
  });

  it("quotes the unfloored-recovery finding", () => {
    // 0.669 and 178% came from the run BEFORE the baseline floor existed, so
    // they cannot be re-derived from the current code. They are pinned as
    // text so the claim cannot quietly change, and the README says plainly
    // that the control row reads 0.0% only after the fix.
    assert.match(README, /0\.669/);
    assert.match(README, /178%/);
    assert.match(README, /only \*\*after\*\* that fix/);
  });
});

describe("the sweep says what the README says it says", () => {
  it("includes a true control that neither helps nor costs", () => {
    const control = sweep.find((row) => row.disputeTightenStep === 0);
    assert.ok(control);
    assert.equal(control.harmReduction.toFixed(1), "0.0");
    assert.equal(control.extraWantedHeld, 0);
  });

  it("is monotonic — more tightening buys less harm at more cost", () => {
    const ordered = [...sweep].sort((a, b) => a.disputeTightenStep - b.disputeTightenStep);
    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      // Same recovery rate only; the +0.03 rows differ on recovery and are
      // expected to break strict ordering against each other.
      if (previous.streakLoosenEvery !== current.streakLoosenEvery) continue;
      assert.ok(
        current.harmReduction >= previous.harmReduction,
        `${current.label} should not cut less harm than ${previous.label}`
      );
      assert.ok(
        current.wantedCompletionRate <= previous.wantedCompletionRate,
        `${current.label} should not be more useful than ${previous.label}`
      );
    }
  });

  it("shows the shipped default sitting where the README says", () => {
    const shipped = sweep.find(
      (row) => row.disputeTightenStep === 0.03 && row.streakLoosenEvery === 2
    );
    assert.ok(shipped, "the shipped tuning must appear in its own sweep");
    assert.match(README, new RegExp(`${shipped.harmReduction.toFixed(1)}%`));
  });
});
