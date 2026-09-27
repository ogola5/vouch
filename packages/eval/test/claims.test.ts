import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { DEFAULT_TRIAL, lateHarmReduction, restockSummary, runRestockTrial, runTrial } from "@vouch/eval";
import type { AutoBuySweepRow, RestockResult, SweepRow, TrialResult } from "@vouch/eval";

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

describe("restocking: the README's numbers are what the simulation produces", () => {
  const restock = JSON.parse(
    readFileSync(new URL("../results/restock.json", import.meta.url), "utf8")
  ) as RestockResult;
  const s = restockSummary(restock);
  const pct = (n: number) => `${Math.abs(n).toFixed(1)}%`;

  it("reproduces exactly from the same seed", () => {
    const rerun = runRestockTrial(restock.config);
    for (const policy of ["forecast", "forecastNoQuestions", "forecastWeekly", "calendarStated", "calendarMonthly", "autoBuy"] as const) {
      assert.deepEqual(rerun[policy], restock[policy], policy);
    }
    assert.deepEqual(rerun.forecastAccuracy, restock.forecastAccuracy);
  });

  it("ran the scale and the fair baseline the README claims", () => {
    assert.equal(restock.itemYears, 1200);
    assert.match(README, /1,200\s+item-years/);
    assert.match(README, /own stated\s+interval/);
    assert.equal(restock.config.tellsRunoutRate, 0.7);
  });

  it("headlines the default's win against the fair calendar", () => {
    for (const n of [s.forecast.stockoutDaysChange, s.forecast.stockHeldChange, s.forecast.packsChange, s.forecast.earlyChange]) {
      assert.ok(n < 0, "every headline number is a reduction");
      assert.match(README, new RegExp(pct(n).replace(".", "\\.")));
    }
  });

  it("states the cost in questions next to the win", () => {
    // The guardrail again: a win reported without its cost is an overclaim.
    assert.match(README, new RegExp(`${s.forecast.questionsPerHouseholdWeek.toFixed(1)} one-tap questions`));
    assert.match(README, new RegExp(`${s.forecastWeekly.questionsPerHouseholdWeek.toFixed(1)} questions a week`));
  });

  it("says that never asking avoids run-outs by hoarding", () => {
    assert.ok(s.forecastNoQuestions.stockHeldChange > 0);
    assert.match(README, new RegExp(`${pct(s.forecastNoQuestions.stockHeldChange).replace(".", "\\.")} more stock`));
    assert.match(README, /by hoarding/);
  });

  it("reports calibration, which the forecast has to earn", () => {
    const coverage = restock.forecastAccuracy.coverage80 * 100;
    assert.ok(coverage > 75 && coverage < 85, `an 80% range should hold about 80% of the time; got ${coverage}`);
    assert.match(README, new RegExp(`${coverage.toFixed(1)}%`));
    assert.match(README, new RegExp(`${restock.forecastAccuracy.meanAbsErrorDays.toFixed(1)} days`));
  });
});

describe("Auto Buy (W4): the README's comparison is what the simulation produces", () => {
  const restock = JSON.parse(
    readFileSync(new URL("../results/restock.json", import.meta.url), "utf8")
  ) as RestockResult;
  const curve = JSON.parse(
    readFileSync(new URL("../results/autobuy-sweep.json", import.meta.url), "utf8")
  ) as AutoBuySweepRow[];
  const s = restockSummary(restock).autoBuyVsForecast;
  const n = (v: number) => v.toLocaleString("en-US");

  it("adding prices moved none of the numbers published before it", () => {
    // Prices draw from their own stream. If they shared one, every forecast
    // and calendar figure above would have shifted.
    assert.equal(restock.forecast.stockoutDays, 3375);
    assert.equal(restock.calendarStated.stockoutDays, 4295);
    assert.equal(restock.forecastNoQuestions.packsBought, 31065);
  });

  it("headlines the gap and Auto Buy's win side by side", () => {
    assert.match(README, new RegExp(`${s.stockoutDaysTimes.toFixed(1)}× as many days out of stock`));
    const byHand = s.boughtByHousehold.autoBuy / s.boughtByHousehold.forecast;
    assert.match(README, new RegExp(`reorder by hand ${byHand.toFixed(1)}× as often`));
    // The cost to Vouch's side of the argument, stated in the same sentence group.
    assert.ok(s.pricePaidChange < 0, "Auto Buy should pay less — that is what it is for");
    assert.match(README, new RegExp(`pays ${Math.abs(s.pricePaidChange).toFixed(1)}% less per pack`));
    for (const v of [restock.autoBuy.stockoutDays, restock.autoBuy.boughtByHousehold, restock.forecast.boughtByHousehold]) {
      assert.match(README, new RegExp(n(v)));
    }
  });

  it("publishes the whole deal-frequency curve, including where Auto Buy wins", () => {
    for (const row of curve) {
      assert.match(README, new RegExp(`${n(row.autoBuy.stockoutDays)} / ${n(row.forecast.stockoutDays)}`));
      assert.match(README, new RegExp(`${row.autoBuy.meanStockDays.toFixed(1)}\\** / ${row.forecast.meanStockDays.toFixed(1)} days`));
    }
    // The shape the claim rests on: rare deals run out, frequent deals stockpile.
    const rare = curve.find((r) => r.dealEveryDays === 60)!;
    const often = curve.find((r) => r.dealEveryDays === 7)!;
    assert.ok(rare.autoBuy.stockoutDays > 5 * rare.forecast.stockoutDays);
    assert.ok(often.autoBuy.stockoutDays <= often.forecast.stockoutDays, "weekly deals: Auto Buy's win");
    assert.ok(often.autoBuy.meanStockDays > 5 * often.forecast.meanStockDays, "…bought by stockpiling");
    assert.match(README, /never sees what is left/);
  });

  it("reproduces a curve row from the same seed", () => {
    // One row (the one where Auto Buy wins) rather than all four, to keep `npm test` fast.
    const often = curve.find((r) => r.dealEveryDays === 7)!;
    const rerun = runRestockTrial({ ...restock.config, dealsPerDay: 1 / 7 });
    assert.equal(rerun.autoBuy.stockoutDays, often.autoBuy.stockoutDays);
    assert.equal(rerun.autoBuy.meanStockDays, often.autoBuy.meanStockDays);
  });

  it("states the assumptions it rests on", () => {
    assert.match(README, /re-arms Auto Buy after every purchase/);
    assert.match(README, /not Amazon data/);
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
