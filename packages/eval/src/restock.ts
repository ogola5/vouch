import { DEMO_ITEMS, forecast, type HouseholdEvent, type ItemProfile, type QuestionMode } from "@vouch/household";
import { mulberry32 } from "./simulate.ts";

/**
 * Does restocking from a forecast beat restocking on a calendar?
 *
 * Amazon's Scheduled Actions restock on a calendar ("every month", "if I
 * haven't bought it in 2 months" — BUILD_PLAN.md §5c). The household model
 * restocks from a forecast of when THIS house runs out. This measures whether
 * that is actually better, on the two failures a household feels: running
 * out, and buying before it was needed.
 *
 * WHAT THIS IS NOT. Synthetic households, not real ones. Every behaviour
 * below is an assumption, listed in DEFAULT_RESTOCK and in the README, and
 * a different assumption would move every number.
 *
 * UNFLATTERING ON PURPOSE, in two ways a reader can check:
 *  - The main calendar baseline uses the household's OWN stated interval —
 *    the best a calendar could do — not a generic "every month". The generic
 *    one is reported too.
 *  - Households say "we're out" only 70% of the time, so the forecast has to
 *    cope with silence, which is the realistic case.
 *
 * HOW IT COULD FAIL, stated before the numbers: a forecast that learns from
 * noisy, partly-reported history could run out MORE than a steady calendar,
 * or overstock to compensate. Both are measured.
 */

export interface RestockConfig {
  households: number;
  days: number;
  seed: number;
  /** How far a household's real pace sits from the category guess (log sd). */
  householdPaceSpread: number;
  /** Pack-to-pack irregularity: busy weeks, bigger loads (log sd). */
  packNoise: number;
  /** How far "how often do you buy this?" is from the truth (log sd). */
  answerError: number;
  /** Chance a household tells the agent "we're out" when it happens. */
  tellsRunoutRate: number;
  /** Chance per day that a 3-day visit starts, using 1.6x as much. */
  guestsPerDay: number;
  /** Chance the household answers "roughly how much is left?" when asked. */
  answersQuestionRate: number;
  /** How rough that answer is before it is snapped to "half", "one"… (log sd). */
  levelAnswerError: number;
  /** Chance per day that a deal starts on an item (W4, the Auto Buy baseline). */
  dealsPerDay: number;
  /** How long a deal lasts, in days. */
  dealDays: number;
  /** Price during a deal, as a fraction of the usual price. */
  dealPrice: number;
  /** The target a household sets on Auto Buy, as a fraction of the usual price. */
  autoBuyTarget: number;
}

export const DEFAULT_RESTOCK: RestockConfig = {
  households: 200,
  days: 365,
  seed: 20260927,
  householdPaceSpread: 0.35,
  packNoise: 0.2,
  answerError: 0.25,
  tellsRunoutRate: 0.7,
  guestsPerDay: 1 / 45,
  answersQuestionRate: 0.8,
  levelAnswerError: 0.3,
  dealsPerDay: 1 / 30,
  dealDays: 4,
  dealPrice: 0.8,
  autoBuyTarget: 0.85,
};

/** What a person actually says: almost out, a quarter, half, one, two, three. */
const LEVEL_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 3];
function snapToBucket(packs: number): number {
  return LEVEL_BUCKETS.reduce((best, b) => (Math.abs(Math.log(b / packs)) < Math.abs(Math.log(best / packs)) ? b : best));
}

export interface PolicyMetrics {
  /** Item-days a household spent with none left — the failure it notices most. */
  stockoutDays: number;
  /** Times an item ran out. */
  runouts: number;
  packsBought: number;
  /** Deliveries that arrived with more than a full pack still in the house: bought too early. */
  earlyArrivals: number;
  /** Mean days of supply sitting in the house: clutter, and money spent early. */
  meanStockDays: number;
  /** "Roughly how much is left?" questions put to the household — a cost, counted as one. */
  questionsAsked: number;
  /** Sum of the prices paid, each as a fraction of the usual price. Divide by packsBought for the mean. */
  spend: number;
  /** Packs the household had to order by hand after running out — the policy's job, done by a person. */
  boughtByHousehold: number;
}

export interface RestockResult {
  config: RestockConfig;
  itemYears: number;
  forecast: PolicyMetrics;
  /** The same forecast, never asking the household anything. */
  forecastNoQuestions: PolicyMetrics;
  /** The same forecast, allowed to ask about an item once a week. */
  forecastWeekly: PolicyMetrics;
  /** Calendar at the household's own stated interval — the fair baseline. */
  calendarStated: PolicyMetrics;
  /** Calendar at a flat 30 days — "every month". */
  calendarMonthly: PolicyMetrics;
  /**
   * Amazon's Auto Buy: buy when the price reaches the household's target,
   * with no view of how much is left (BUILD_PLAN.md §5c, primary). Re-armed
   * by the household after every purchase — the most generous reading.
   */
  autoBuy: PolicyMetrics;
  /** How right the forecast's "days left" was, on days it had stock to forecast. */
  forecastAccuracy: { meanAbsErrorDays: number; coverage80: number; daysMeasured: number };
}

type Policy = "forecast" | "forecastNoQuestions" | "forecastWeekly" | "calendarStated" | "calendarMonthly" | "autoBuy";

const QUESTION_MODE: Partial<Record<Policy, QuestionMode>> = {
  forecast: "once-per-pack",
  forecastNoQuestions: "off",
  forecastWeekly: "weekly",
};

function normal(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** One household's world for one item: fixed before any policy runs, so every policy faces the same one. */
interface World {
  profile: ItemProfile;
  truePace: number;
  /** Days each successive pack lasts at normal usage. */
  packDays: number[];
  guestDay: boolean[];
  calendarInterval: number;
  /** Each day's price as a fraction of the usual: 1, or `dealPrice` during a deal. */
  price: number[];
}

/*
 * Prices come from their own random stream, drawn after everything else, so
 * adding them left every number published before W4 exactly as it was
 * (test/claims.test.ts re-derives them).
 */
function buildPrices(config: RestockConfig, rng: () => number): number[] {
  const price = Array.from({ length: config.days }, () => 1);
  for (let day = 0; day < config.days; day++) {
    if (rng() < config.dealsPerDay) {
      for (let d = day; d < Math.min(config.days, day + config.dealDays); d++) price[d] = config.dealPrice;
    }
  }
  return price;
}

function buildWorld(config: RestockConfig, item: ItemProfile, rng: () => number, priceRng: () => number): World {
  const truePace = item.defaultDaysPerPack * Math.exp(normal(rng) * config.householdPaceSpread);
  const answered = truePace * Math.exp(normal(rng) * config.answerError);
  const packDays = Array.from({ length: 400 }, () => truePace * Math.exp(normal(rng) * config.packNoise));
  const guestDay = Array.from({ length: config.days }, () => false);
  for (let day = 0; day < config.days; day++) {
    if (rng() < config.guestsPerDay) for (let d = day; d < Math.min(config.days, day + 3); d++) guestDay[d] = true;
  }
  return {
    profile: { ...item, answeredDaysPerPack: answered },
    truePace,
    packDays,
    guestDay,
    calendarInterval: Math.max(1, Math.round(answered)),
    price: buildPrices(config, priceRng),
  };
}

interface Accuracy {
  absError: number;
  inside: number;
  measured: number;
}

function runPolicy(
  config: RestockConfig,
  world: World,
  policy: Policy,
  rng: () => number,
  askRng: () => number,
  accuracy: Accuracy
) {
  const lead = world.profile.leadDays;
  const metrics = empty();
  const events: HouseholdEvent[] = [];
  const arrivals = new Map<number, number>();
  let nextPack = 0;
  let stock = 0;
  let stockSum = 0;

  const order = (today: number, by: "household" | "agent") => {
    const arrival = today + lead;
    arrivals.set(arrival, (arrivals.get(arrival) ?? 0) + 1);
    events.push({ kind: "purchase", day: arrival, packs: 1, by });
    metrics.packsBought++;
    metrics.spend += world.price[today]!;
    if (by === "household") metrics.boughtByHousehold++;
  };
  const onTheWay = (today: number) => [...arrivals.keys()].some((d) => d > today);

  // Every household starts with one pack it bought itself on day 0.
  stock = world.packDays[nextPack++]!;
  events.push({ kind: "purchase", day: 0, packs: 1, by: "household" });
  metrics.packsBought++;
  metrics.spend += world.price[0]!;
  let manualReorderOn: number | null = null;

  for (let day = 1; day < config.days; day++) {
    for (let n = arrivals.get(day) ?? 0; n > 0; n--) {
      if (stock > world.truePace) metrics.earlyArrivals++;
      stock += world.packDays[nextPack++ % world.packDays.length]!;
    }

    if (stock <= 0) {
      metrics.stockoutDays++;
    } else {
      stock -= world.guestDay[day] ? 1.6 : 1;
      if (stock <= 0) {
        stock = 0;
        metrics.runouts++;
        if (rng() < config.tellsRunoutRate) events.push({ kind: "runout", day });
        // The household notices and reorders itself within a couple of days
        // — unless something is already on the way. Same for every policy.
        manualReorderOn = day + Math.floor(rng() * 3);
      }
    }

    if (manualReorderOn !== null && day >= manualReorderOn) {
      if (!onTheWay(day)) order(day, "household");
      manualReorderOn = null;
    }

    const questions = QUESTION_MODE[policy];
    if (questions !== undefined) {
      const f = forecast(world.profile, events, day, { questions });
      if (policy === "forecast" && f.status === "stocked" && f.daysLeft && !f.orderOnTheWay && stock > 0) {
        accuracy.measured++;
        accuracy.absError += Math.abs(f.daysLeft.median - stock);
        if (stock >= f.daysLeft.low && stock <= f.daysLeft.high) accuracy.inside++;
      }
      if (f.shouldPropose) order(day, "agent");
      if (f.shouldAsk) {
        metrics.questionsAsked++;
        if (askRng() < config.answersQuestionRate) {
          const truePacks = stock / world.truePace;
          const said = truePacks <= 0 ? 0 : snapToBucket(truePacks * Math.exp(normal(askRng) * config.levelAnswerError));
          events.push({ kind: "level", day, packs: said });
        }
      }
    } else if (policy === "autoBuy") {
      // Fires once when a deal brings the price to the target, then the
      // household re-arms it. It never sees how much is left.
      const hit = (d: number) => world.price[d]! <= config.autoBuyTarget;
      if (hit(day) && !hit(day - 1)) order(day, "agent");
    } else {
      const interval = policy === "calendarStated" ? world.calendarInterval : 30;
      if (day % interval === 0) order(day, "agent");
    }

    stockSum += stock;
  }

  metrics.meanStockDays = stockSum / (config.days - 1);
  return metrics;
}

function add(into: PolicyMetrics, from: PolicyMetrics): void {
  into.stockoutDays += from.stockoutDays;
  into.runouts += from.runouts;
  into.packsBought += from.packsBought;
  into.earlyArrivals += from.earlyArrivals;
  into.meanStockDays += from.meanStockDays;
  into.questionsAsked += from.questionsAsked;
  into.spend += from.spend;
  into.boughtByHousehold += from.boughtByHousehold;
}

function empty(): PolicyMetrics {
  return {
    stockoutDays: 0, runouts: 0, packsBought: 0, earlyArrivals: 0, meanStockDays: 0, questionsAsked: 0,
    spend: 0, boughtByHousehold: 0,
  };
}

/** Mean price paid per pack, as a fraction of the usual price. */
export const meanPricePaid = (m: PolicyMetrics) => m.spend / m.packsBought;

/** Percent change from `base` to `value`; negative means fewer. */
const change = (value: number, base: number) => ((value - base) / base) * 100;

/**
 * The comparisons the README states, computed in one place so the printout,
 * the README and test/claims.test.ts cannot disagree about rounding.
 */
export function restockSummary(r: RestockResult) {
  const weeks = (r.config.households * r.config.days) / 7;
  const vs = (m: PolicyMetrics) => ({
    stockoutDaysChange: change(m.stockoutDays, r.calendarStated.stockoutDays),
    stockHeldChange: change(m.meanStockDays, r.calendarStated.meanStockDays),
    packsChange: change(m.packsBought, r.calendarStated.packsBought),
    earlyChange: change(m.earlyArrivals, r.calendarStated.earlyArrivals),
    questionsPerHouseholdWeek: m.questionsAsked / weeks,
  });
  return {
    forecast: vs(r.forecast),
    forecastNoQuestions: vs(r.forecastNoQuestions),
    forecastWeekly: vs(r.forecastWeekly),
    calendarMonthly: vs(r.calendarMonthly),
    /** W4: Amazon's Auto Buy against the default forecast — including where Auto Buy wins. */
    autoBuyVsForecast: {
      stockoutDaysTimes: r.autoBuy.stockoutDays / r.forecast.stockoutDays,
      boughtByHousehold: { autoBuy: r.autoBuy.boughtByHousehold, forecast: r.forecast.boughtByHousehold },
      pricePaidChange: change(meanPricePaid(r.autoBuy), meanPricePaid(r.forecast)),
      earlyArrivals: { autoBuy: r.autoBuy.earlyArrivals, forecast: r.forecast.earlyArrivals },
    },
  };
}

export interface AutoBuySweepRow {
  dealEveryDays: number;
  autoBuy: { stockoutDays: number; meanStockDays: number; meanPricePaid: number; boughtByHousehold: number };
  forecast: { stockoutDays: number; meanStockDays: number; meanPricePaid: number; boughtByHousehold: number };
}

/**
 * Auto Buy's result depends on how often prices drop, which is an assumption,
 * so it is published as a curve rather than one number. The expected shape:
 * rare deals, and a price trigger runs out; frequent deals, and it
 * stockpiles. It cannot do both well because it never sees what is left.
 */
export function runAutoBuySweep(config: RestockConfig = DEFAULT_RESTOCK): AutoBuySweepRow[] {
  const pick = (m: PolicyMetrics) => ({
    stockoutDays: m.stockoutDays,
    meanStockDays: m.meanStockDays,
    meanPricePaid: meanPricePaid(m),
    boughtByHousehold: m.boughtByHousehold,
  });
  return [60, 30, 14, 7].map((dealEveryDays) => {
    const r = runRestockTrial({ ...config, dealsPerDay: 1 / dealEveryDays });
    return { dealEveryDays, autoBuy: pick(r.autoBuy), forecast: pick(r.forecast) };
  });
}

export function runRestockTrial(config: RestockConfig = DEFAULT_RESTOCK): RestockResult {
  const totals: Record<Policy, PolicyMetrics> = {
    forecast: empty(),
    forecastNoQuestions: empty(),
    forecastWeekly: empty(),
    calendarStated: empty(),
    calendarMonthly: empty(),
    autoBuy: empty(),
  };
  const accuracy: Accuracy = { absError: 0, inside: 0, measured: 0 };
  let itemYears = 0;

  for (let h = 0; h < config.households; h++) {
    for (const [i, item] of DEMO_ITEMS.entries()) {
      const streamSeed = config.seed + h * 101 + i * 7;
      const world = buildWorld(config, item, mulberry32(streamSeed), mulberry32(streamSeed ^ 0x9e3779b9));
      for (const policy of Object.keys(totals) as Policy[]) {
        // The household's own behaviour (telling, reorder delay) draws from
        // an identical stream under every policy.
        add(
          totals[policy],
          runPolicy(config, world, policy, mulberry32(streamSeed ^ 0x5bd1e995), mulberry32(streamSeed ^ 0x2545f491), accuracy)
        );
      }
      itemYears++;
    }
  }

  for (const metrics of Object.values(totals)) metrics.meanStockDays /= itemYears;

  return {
    config,
    itemYears,
    ...totals,
    forecastAccuracy: {
      meanAbsErrorDays: accuracy.absError / accuracy.measured,
      coverage80: accuracy.inside / accuracy.measured,
      daysMeasured: accuracy.measured,
    },
  };
}
