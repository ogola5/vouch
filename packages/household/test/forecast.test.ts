import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { DEMO_ITEMS, estimatePace, forecast, normalCdf } from "@vouch/household";
import type { HouseholdEvent, ItemProfile } from "@vouch/household";

/**
 * The forecast is plain statistics, so it is tested like the gate: exact
 * inputs, exact expectations, no model anywhere near it.
 */

const detergent: ItemProfile = { ...DEMO_ITEMS.find((i) => i.item_id === "detergent")! };

const bought = (day: number, by: "household" | "agent" = "household", packs = 1): HouseholdEvent => ({
  kind: "purchase",
  day,
  packs,
  by,
});
const out = (day: number): HouseholdEvent => ({ kind: "runout", day });

/** Three bottles that each lasted exactly 24 days, ending "we're out". */
const EVERY_24_DAYS: HouseholdEvent[] = [bought(0), out(24), bought(25), out(49), bought(50), out(74)];

describe("where the pace comes from", () => {
  it("starts from the labelled guess, and will not guess what is in the house", () => {
    const f = forecast(detergent, [], 10);
    assert.equal(f.status, "no-history");
    assert.equal(f.shouldPropose, false, "buying on a guess about stock is exactly what it must not do");
    assert.equal(f.pace.basis, "a starting guess");
    assert.equal(Math.round(f.pace.daysPerPack), detergent.defaultDaysPerPack);
  });

  it("uses the household's own answer over the guess", () => {
    const pace = estimatePace({ ...detergent, answeredDaysPerPack: 20 }, [], 0);
    assert.equal(pace.basis, "your answer");
    assert.equal(Math.round(pace.daysPerPack), 20);
  });

  it("learns from 'we're out', moving from the guess toward what actually happened", () => {
    const pace = estimatePace(detergent, EVERY_24_DAYS, 74);
    assert.equal(pace.basis, "your history");
    assert.equal(pace.exactObservations, 3);
    // Guess 30 worth two refills, three real refills of 24: the geometric
    // blend is 30^0.4 x 24^0.6 = 26.3. Closer to the history than the guess.
    assert.ok(pace.daysPerPack > 24 && pace.daysPerPack < 27, `got ${pace.daysPerPack}`);
  });

  it("does NOT treat an early agent purchase as the house running out", () => {
    // The trap: the agent buys before the house runs out, by design. Reading
    // that as "it only lasted 20 days" would make it buy earlier every cycle.
    const pace = estimatePace(detergent, [bought(0), bought(20, "agent")], 30);
    assert.ok(pace.daysPerPack >= 29.9, `an early purchase dragged the pace down to ${pace.daysPerPack}`);
    assert.equal(pace.exactObservations, 0);
  });

  it("treats 'we still have plenty' as evidence it lasts longer", () => {
    const pace = estimatePace(detergent, [bought(0), { kind: "plenty", day: 45 }], 45);
    assert.ok(pace.daysPerPack > 30, `plenty at day 45 should slow the pace; got ${pace.daysPerPack}`);
  });

  it("does not treat silence as 'still lasting'", () => {
    // Households run out without saying so. If a quiet day counted as
    // evidence, the pace would slow every day nobody spoke and the next
    // purchase would slide later — a stock-out it talked itself into.
    const quiet = estimatePace(detergent, [bought(0)], 60);
    assert.equal(Math.round(quiet.daysPerPack), detergent.defaultDaysPerPack);
  });
});

describe("when to buy", () => {
  const history = [...EVERY_24_DAYS, bought(75)];

  it("does not buy the day after the last bottle arrived", () => {
    const f = forecast(detergent, history, 76);
    assert.equal(f.status, "stocked");
    assert.equal(f.shouldPropose, false);
    assert.ok(f.runoutRisk < 0.01);
  });

  it("buys when running out before a delivery becomes likely enough", () => {
    const f = forecast(detergent, history, 100);
    assert.equal(f.shouldPropose, true, f.reason);
    assert.ok(f.runoutRisk >= 0.2);
  });

  it("never orders twice while one is on the way", () => {
    const f = forecast(detergent, [...history, bought(102, "agent")], 100);
    assert.equal(f.orderOnTheWay, true);
    assert.equal(f.shouldPropose, false);
  });

  it("buys straight away after 'we're out' — unless it is already coming", () => {
    const outNow = forecast(detergent, [...history, out(98)], 98);
    assert.equal(outNow.status, "out");
    assert.equal(outNow.shouldPropose, true);

    const coming = forecast(detergent, [...history, out(98), bought(100, "agent")], 98);
    assert.equal(coming.status, "out");
    assert.equal(coming.shouldPropose, false);
  });

  it("a household that never wants to run out is asked to buy earlier than one keeping stock low", () => {
    const firstDay = (riskTolerance: number) => {
      for (let day = 76; day < 140; day++) {
        if (forecast(detergent, history, day, { riskTolerance }).shouldPropose) return day;
      }
      return Infinity;
    };
    const never = firstDay(0.05);
    const shipped = firstDay(0.2);
    const low = firstDay(0.33);
    assert.ok(never < shipped && shipped < low, `expected ${never} < ${shipped} < ${low}`);
  });

  it("gives an 80% range around the middle, and risk only grows as days pass", () => {
    let previous = -1;
    for (let day = 76; day <= 110; day++) {
      const f = forecast(detergent, history, day);
      assert.ok(f.daysLeft!.low <= f.daysLeft!.median && f.daysLeft!.median <= f.daysLeft!.high);
      assert.ok(f.runoutRisk >= previous, `risk fell on day ${day}`);
      previous = f.runoutRisk;
    }
  });
});

describe("asking 'roughly how much is left?'", () => {
  const history = [...EVERY_24_DAYS, bought(75)];

  it("an answer re-anchors the stock and teaches the pace", () => {
    // Half a bottle used in 20 days is a 40-day pace — slower than the guess.
    const events = [bought(0), { kind: "level" as const, day: 20, packs: 0.5 }];
    const pace = estimatePace(detergent, events, 20);
    assert.ok(pace.daysPerPack > 30, `got ${pace.daysPerPack}`);

    const f = forecast(detergent, events, 20);
    assert.equal(f.supply?.since, 20, "the forecast should now project from the answer, not from day 0");
    assert.ok(f.daysLeft!.median > 10 && f.daysLeft!.median < 25, `half a bottle left; got ${f.daysLeft!.median}`);
  });

  it("'none left' counts as running out", () => {
    const f = forecast(detergent, [bought(0), { kind: "level", day: 20, packs: 0 }], 20);
    assert.equal(f.status, "out");
  });

  const firstAsk = (events: HouseholdEvent[], questions: "off" | "once-per-pack" | "weekly") => {
    for (let day = 76; day < 140; day++) if (forecast(detergent, events, day, { questions }).shouldAsk) return day;
    return null;
  };

  it("asks before it would buy, while the answer could still change the decision", () => {
    const day = firstAsk(history, "once-per-pack");
    assert.ok(day !== null, "it should ask at some point in the cycle");
    const f = forecast(detergent, history, day!);
    assert.equal(f.shouldPropose, false, "a question on the day it buys anyway changes nothing");
  });

  it("asks at most once per delivery", () => {
    const day = firstAsk(history, "once-per-pack")!;
    const answered = [...history, { kind: "level" as const, day, packs: 0.5 }];
    for (let later = day; later < day + 30; later++) {
      assert.equal(forecast(detergent, answered, later).shouldAsk, false, `asked again on day ${later}`);
    }
  });

  it("never asks when the household has turned questions off", () => {
    assert.equal(firstAsk(history, "off"), null);
  });
});

describe("the arithmetic underneath", () => {
  it("has a standard normal CDF that is actually standard", () => {
    assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
    assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
    assert.ok(Math.abs(normalCdf(-1.2816) - 0.1) < 1e-3);
  });
});
