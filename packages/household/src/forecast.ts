import type { ItemProfile } from "./items.ts";

/**
 * When will this household run out of this item, and should the agent buy
 * it now?
 *
 * NUMBERS FROM ARITHMETIC, WORDS FROM THE MODEL. This file is plain
 * statistics on purpose: reproducible, testable, and unable to invent a
 * number. A language model may later turn "we're out of dish soap" into an
 * event for this file, or put its output into a sentence — it never computes
 * a forecast and never decides a purchase. Authority stays with the gate.
 *
 * Pure and synchronous, like evaluateProposal: events and a day in, a
 * forecast out. No clock, no I/O — the caller says what "today" is, which is
 * also what lets the demo fast-forward and the simulation replay a year.
 *
 * Time is whole days. A purchase event's `day` is the day the stock ARRIVED
 * (a future day means it is still on the way), because stock cannot be used
 * before it is in the house.
 */

export type HouseholdEvent =
  | {
      kind: "purchase";
      day: number;
      packs: number;
      by: "household" | "agent";
      /** Which product, and at what unit price — the evidence for "your usual, at your usual price". */
      product_id?: string;
      price?: number;
    }
  /** "We're out" — the most informative thing a household can say. */
  | { kind: "runout"; day: number }
  /** "We still have plenty" — it has lasted at least this long. */
  | { kind: "plenty"; day: number }
  /**
   * The answer to "roughly how much is left?", in packs: almost out ~0.1,
   * half ~0.5, a full one ~1. Re-anchors the stock and teaches the pace.
   *
   * This exists because of the first simulation run (2026-09-27): an agent
   * that buys BEFORE the house runs out never hears "we're out", so it never
   * learns, and projecting ten bottles ahead from the first one turned a 25%
   * pace error into months — it averaged 90 days of stock in the house.
   */
  | { kind: "level"; day: number; packs: number };

/**
 * How often the household is willing to be asked "roughly how much is left?".
 * A household setting, because it is a genuine trade-off: more answers mean
 * fewer run-outs, and every answer is a moment of someone's attention.
 */
export type QuestionMode = "off" | "once-per-pack" | "weekly";

export interface ForecastOptions {
  /** Default "once-per-pack". */
  questions?: QuestionMode;
  /**
   * Propose once the chance of running out before a delivery could arrive
   * reaches this. The owner chose 1 in 5 (2026-09-27). A household can move
   * it in plain words: "never let me run out" ~ 0.05, "keep stock low" ~ 0.33.
   */
  riskTolerance?: number;
}

export const DEFAULT_RISK_TOLERANCE = 0.2;

/**
 * The starting guess counts as this many refills. Two, so it gives a forecast
 * on day one but real history outweighs it after a couple of cycles.
 */
export const PRIOR_WEIGHT = 2;

/** Spread of the starting guess, on a log scale (~ ±45%, or ±30% if the household answered). */
const PRIOR_SPREAD_DEFAULT = 0.45;
const PRIOR_SPREAD_ANSWERED = 0.3;
/** Never claim to know a household's pace better than ±10%: people are irregular. */
const MIN_SPREAD = 0.1;
/**
 * A reorder the household placed itself, with no "we're out" in between, is
 * taken as "about when they ran low" — an assumption, so it counts half.
 */
const REORDER_WEIGHT = 0.5;
const LOWER_BOUND_WEIGHT = 0.5;
/** A rough "about half left" is informative but coarse. */
const LEVEL_WEIGHT = 0.75;
/**
 * In "once-per-pack" mode, ask at most once per delivery, and only while the
 * forecast's range is wider than this. The measured trade-off between the
 * modes is in packages/eval/README.md.
 */
export const ASK_ONLY_IF_RANGE_WIDER_THAN_DAYS = 7;

/** z-scores for the 80% range shown to the household. */
const Z10 = -1.2816;
const Z90 = 1.2816;

export interface PaceEstimate {
  /** Typical days one pack lasts this household (the median). */
  daysPerPack: number;
  /** Where the estimate comes from, in words a household would recognise. */
  basis: "a starting guess" | "your answer" | "your history";
  /** Refill cycles that informed it, not counting the starting guess. */
  observations: number;
  /** Of which, cycles that ended in a "we're out" — the exact ones. */
  exactObservations: number;
  logMean: number;
  /** Predictive spread on a log scale: the uncertainty about the NEXT pack. */
  logSpread: number;
  /** How irregular one pack is (log sd). Averages out across several packs. */
  packSpread: number;
  /** How unsure we are about the household's typical pace (log sd). Does NOT average out. */
  paceUncertainty: number;
}

export type ForecastStatus = "no-history" | "stocked" | "out";

export interface Forecast {
  status: ForecastStatus;
  pace: PaceEstimate;
  /** Days of stock left: an 80% range and the middle. Null with no history. */
  daysLeft: { low: number; median: number; high: number } | null;
  /** Chance of running out before an order placed today would arrive. */
  runoutRisk: number;
  /** An order has been placed and has not arrived yet. */
  orderOnTheWay: boolean;
  shouldPropose: boolean;
  /**
   * Ask "roughly how much is left?" — only when a purchase is getting close
   * and the answer could change it, and at most once a week per item.
   */
  shouldAsk: boolean;
  /** The day the current supply started, and how many packs it holds. */
  supply: { since: number; packs: number } | null;
  /** Why it said what it said, as structured facts a sentence can be built from. */
  reason: string;
}

interface Observation {
  logDays: number;
  weight: number;
  exact: boolean;
}

/**
 * How many days one pack lasts this household, from its refill history.
 *
 * Exported so the explanation can show its basis and the simulation can
 * measure it directly.
 */
export function estimatePace(profile: ItemProfile, events: readonly HouseholdEvent[], today: number): PaceEstimate {
  const answered = profile.answeredDaysPerPack !== undefined && profile.answeredDaysPerPack > 0;
  const priorDays = answered ? profile.answeredDaysPerPack! : profile.defaultDaysPerPack;
  const priorMean = Math.log(priorDays);
  const priorSpread = answered ? PRIOR_SPREAD_ANSWERED : PRIOR_SPREAD_DEFAULT;

  const { observations, lowerBound } = collectObservations(events, today);

  let { mean, spread, weight } = combine(priorMean, priorSpread, observations);

  // A supply that has lasted longer than we expected is evidence the pace is
  // slower. It can only raise the estimate, never lower it, so it is applied
  // only when it exceeds what the history already says.
  if (lowerBound !== null && Math.log(lowerBound) > mean) {
    observations.push({ logDays: Math.log(lowerBound), weight: LOWER_BOUND_WEIGHT, exact: false });
    ({ mean, spread, weight } = combine(priorMean, priorSpread, observations));
  }

  return {
    daysPerPack: Math.exp(mean),
    basis: observations.length > 0 ? "your history" : answered ? "your answer" : "a starting guess",
    observations: observations.length,
    exactObservations: observations.filter((o) => o.exact).length,
    logMean: mean,
    // Predictive: the spread of one more pack, including our uncertainty
    // about the mean, not just the household's own irregularity.
    logSpread: Math.max(MIN_SPREAD, spread) * Math.sqrt(1 + 1 / weight),
    packSpread: Math.max(MIN_SPREAD, spread),
    paceUncertainty: Math.max(MIN_SPREAD, spread) / Math.sqrt(weight),
  };
}

/**
 * Spread of the run-out day for a supply of `packs`, on a log scale.
 *
 * Two different uncertainties, combined properly. Not knowing the
 * household's pace affects every pack alike, so it does not shrink with more
 * packs. Pack-to-pack irregularity is independent, so it averages out:
 * several bottles together are more predictable than one. The first version
 * treated all of it as shared and made long supplies look far less
 * predictable than they are.
 */
function supplySpread(pace: PaceEstimate, packs: number): number {
  return Math.sqrt(pace.paceUncertainty ** 2 + pace.packSpread ** 2 / Math.max(1, packs));
}

function combine(
  priorMean: number,
  priorSpread: number,
  observations: readonly Observation[]
): { mean: number; spread: number; weight: number } {
  const weight = PRIOR_WEIGHT + observations.reduce((sum, o) => sum + o.weight, 0);
  const mean =
    (PRIOR_WEIGHT * priorMean + observations.reduce((sum, o) => sum + o.weight * o.logDays, 0)) / weight;
  const variance =
    (PRIOR_WEIGHT * priorSpread ** 2 +
      observations.reduce((sum, o) => sum + o.weight * (o.logDays - mean) ** 2, 0)) /
    weight;
  return { mean, spread: Math.sqrt(variance), weight };
}

/**
 * Turns the event history into refill-cycle observations.
 *
 * A "supply" starts when stock arrives after the house was out (or at the
 * first purchase), and ends at "we're out". Only that ending is exact. An
 * agent purchase ends nothing — the agent buys BEFORE the house runs out, by
 * design — so it adds to the supply instead. Treating an early agent purchase
 * as though the house had run out would teach the forecast to buy ever
 * earlier: a loop that feeds on its own caution.
 */
function collectObservations(
  events: readonly HouseholdEvent[],
  today: number
): { observations: Observation[]; lowerBound: number | null } {
  const past = [...events].filter((e) => e.day <= today).sort((a, b) => a.day - b.day);
  const observations: Observation[] = [];
  let supply: { since: number; packs: number } | null = null;
  let lastHouseholdPurchase: { day: number; packs: number } | null = null;
  let lowerBound: number | null = null;

  for (const event of past) {
    if (event.kind === "purchase") {
      if (supply === null) {
        supply = { since: event.day, packs: event.packs };
      } else {
        // A household reorder with no "we're out" since the last one: they
        // probably reordered when running low. Approximate, so half weight.
        if (event.by === "household" && lastHouseholdPurchase !== null) {
          const days = (event.day - lastHouseholdPurchase.day) / lastHouseholdPurchase.packs;
          if (days > 0) observations.push({ logDays: Math.log(days), weight: REORDER_WEIGHT, exact: false });
        }
        supply.packs += event.packs;
      }
      lastHouseholdPurchase = event.by === "household" ? { day: event.day, packs: event.packs } : null;
      continue;
    }

    if (event.kind === "runout" || (event.kind === "level" && event.packs <= 0)) {
      if (supply !== null) {
        const days = (event.day - supply.since) / supply.packs;
        if (days > 0) observations.push({ logDays: Math.log(days), weight: 1, exact: true });
      }
      supply = null;
      lastHouseholdPurchase = null;
      continue;
    }

    if (event.kind === "level") {
      // "About half left": what was used since the last anchor, over the days
      // it took, is a direct reading of the pace. Then re-anchor there, so the
      // next forecast projects from what is actually in the house now.
      if (supply !== null) {
        const used = supply.packs - event.packs;
        const days = event.day - supply.since;
        if (used > 0 && days > 0) {
          observations.push({ logDays: Math.log(days / used), weight: LEVEL_WEIGHT, exact: false });
        }
      }
      supply = { since: event.day, packs: event.packs };
      lastHouseholdPurchase = null;
      continue;
    }

    // "plenty": the supply has lasted at least this long.
    if (supply !== null) {
      lowerBound = Math.max(lowerBound ?? 0, (event.day - supply.since) / supply.packs);
    }
  }

  // Deliberately NOT inferred: "nobody said we're out, so it must still be
  // lasting". Households run out without saying so, and treating silence as
  // evidence would slow the pace every quiet day and push each purchase
  // later — a stock-out the forecast talked itself into. Only an explicit
  // "we still have plenty" counts.

  return { observations, lowerBound: lowerBound && lowerBound > 0 ? lowerBound : null };
}

/** The current supply as of today, including packs that are still on the way. */
function currentSupply(
  events: readonly HouseholdEvent[],
  today: number
): { since: number; packs: number; onTheWay: number } | null | { out: true; onTheWay: number } {
  const sorted = [...events].sort((a, b) => a.day - b.day);
  let supply: { since: number; packs: number } | null = null;
  let everBought = false;
  let onTheWay = 0;

  for (const event of sorted) {
    if (event.kind === "purchase") {
      everBought = true;
      if (event.day > today) {
        onTheWay += event.packs;
        continue;
      }
      if (supply === null) supply = { since: event.day, packs: event.packs };
      else supply.packs += event.packs;
    } else if (event.day > today) {
      continue;
    } else if (event.kind === "runout" || (event.kind === "level" && event.packs <= 0)) {
      supply = null;
    } else if (event.kind === "level") {
      supply = { since: event.day, packs: event.packs };
    }
  }

  if (!everBought) return null;
  if (supply === null) return { out: true, onTheWay };
  return { ...supply, onTheWay };
}

export function forecast(
  profile: ItemProfile,
  events: readonly HouseholdEvent[],
  today: number,
  options: ForecastOptions = {}
): Forecast {
  const tolerance = options.riskTolerance ?? DEFAULT_RISK_TOLERANCE;
  const pace = estimatePace(profile, events, today);
  const supply = currentSupply(events, today);

  if (supply === null) {
    return {
      status: "no-history",
      pace,
      daysLeft: null,
      runoutRisk: 0,
      orderOnTheWay: false,
      shouldPropose: false,
      shouldAsk: false,
      supply: null,
      // Without a single purchase we cannot know what is in the house, and
      // guessing would mean buying on a guess. Ask instead.
      reason: "No purchase recorded yet, so there is no way to know how much is in the house.",
    };
  }

  if ("out" in supply) {
    const onTheWay = supply.onTheWay > 0;
    return {
      status: "out",
      pace,
      daysLeft: { low: 0, median: 0, high: 0 },
      runoutRisk: 1,
      orderOnTheWay: onTheWay,
      shouldPropose: !onTheWay,
      shouldAsk: false,
      supply: null,
      reason: onTheWay
        ? "You said you are out; an order is already on the way."
        : "You said you are out, and nothing is on the way.",
    };
  }

  const packs = supply.packs + supply.onTheWay;
  const orderOnTheWay = supply.onTheWay > 0;
  // Supply runs out at since + packs × D, where D is how long one pack lasts.
  const spread = supplySpread(pace, packs);
  const runoutDayAt = (z: number) => supply.since + packs * Math.exp(pace.logMean + z * spread);
  const daysLeft = {
    low: Math.max(0, runoutDayAt(Z10) - today),
    median: Math.max(0, runoutDayAt(0) - today),
    high: Math.max(0, runoutDayAt(Z90) - today),
  };

  // P(run out before an order placed today could arrive).
  const horizon = today + profile.leadDays - supply.since;
  const runoutRisk = horizon <= 0 ? 0 : normalCdf((Math.log(horizon / packs) - pace.logMean) / spread);

  // Never order twice: if something is already on the way, the forecast
  // above already counts it.
  const shouldPropose = !orderOnTheWay && runoutRisk >= tolerance;

  const mode = options.questions ?? "once-per-pack";
  const statements = events.filter((e) => e.kind !== "purchase" && e.day <= today);
  const lastArrival = events
    .filter((e) => e.kind === "purchase" && e.day <= today)
    .reduce((latest, e) => Math.max(latest, e.day), -Infinity);
  const lastStatement = statements.reduce((latest, e) => Math.max(latest, e.day), -Infinity);
  const allowedByMode =
    mode === "weekly"
      ? today - lastStatement >= 7
      : mode === "once-per-pack"
        ? lastStatement < lastArrival && daysLeft.high - daysLeft.low > ASK_ONLY_IF_RANGE_WIDER_THAN_DAYS
        : false;
  const shouldAsk = !shouldPropose && !orderOnTheWay && runoutRisk >= tolerance / 4 && allowedByMode;

  return {
    status: "stocked",
    pace,
    daysLeft,
    runoutRisk,
    orderOnTheWay,
    shouldPropose,
    shouldAsk,
    supply: { since: supply.since, packs },
    reason: orderOnTheWay
      ? "An order is already on the way."
      : shouldPropose
        ? `About a ${Math.round(runoutRisk * 100)}% chance of running out before a delivery could arrive.`
        : `Only about a ${Math.round(runoutRisk * 100)}% chance of running out before a delivery could arrive.`,
  };
}

/** Standard normal CDF, via Abramowitz & Stegun 7.1.26 (error < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
