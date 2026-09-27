import type { HouseholdEvent } from "./forecast.ts";
import { DEMO_ITEMS } from "./items.ts";

/**
 * The demo household: what it buys, what it allows, and a believable past.
 *
 * SIMULATED, AND SAID SO. The history below is authored, not recorded — it
 * exists so the forecast has something to learn from when the demo starts.
 *
 * Timed so the first days of a fast-forward show ONE thing at a time rather
 * than three purchases on day one: detergent (Auto) buys first, coffee (Ask)
 * asks next, dish soap (Remind) reminds after that, and toilet paper (Auto
 * until a date, weekend deliveries only) shows a delivery window.
 */

export interface DemoItemSetup {
  item_id: string;
  /**
   * How much the household has handed over for this item. The demo shows
   * all three modes at once (owner's decision, 2026-09-28) so one
   * fast-forward shows Auto buying, Ask asking and Remind reminding.
   */
  autonomy: {
    mode: "remind" | "ask" | "auto";
    /** Days after the demo start that Auto lasts; null for no end date. */
    forDays: number | null;
    /** Weekdays a delivery may arrive (0 = Sunday); null for any day. */
    deliveryDays: number[] | null;
  };
  preferred: { product_id: string; brand: string };
  fallback: { product_id: string; brand: string };
  maxPrice: number;
  /** How long a pack really lasts this household, in the authored history. */
  pace: number;
  /** Days of stock left on the day the demo starts. */
  daysLeftAtStart: number;
  usualPrice: number;
}

export const DEMO_START_DAY = 100;

export const DEMO_SETUP: readonly DemoItemSetup[] = [
  {
    item_id: "detergent",
    autonomy: { mode: "auto", forDays: null, deliveryDays: null },
    preferred: { product_id: "detergent-brand-a", brand: "Brand A" },
    fallback: { product_id: "detergent-brand-b", brand: "Brand B" },
    maxPrice: 15,
    pace: 28,
    daysLeftAtStart: 5,
    usualPrice: 14.99,
  },
  {
    item_id: "coffee",
    autonomy: { mode: "ask", forDays: null, deliveryDays: null },
    preferred: { product_id: "coffee-morning-ridge", brand: "Morning Ridge" },
    fallback: { product_id: "coffee-highland-roast", brand: "Highland Roast" },
    maxPrice: 12,
    pace: 12,
    daysLeftAtStart: 6,
    usualPrice: 9.99,
  },
  {
    item_id: "dish-soap",
    autonomy: { mode: "remind", forDays: null, deliveryDays: null },
    preferred: { product_id: "dish-soap-clearwave", brand: "Clearwave" },
    fallback: { product_id: "dish-soap-brightly", brand: "Brightly" },
    maxPrice: 6,
    pace: 21,
    daysLeftAtStart: 9,
    usualPrice: 3.99,
  },
  {
    item_id: "toilet-paper",
    autonomy: { mode: "auto", forDays: 60, deliveryDays: [0, 6] },
    preferred: { product_id: "toilet-paper-cloudsoft", brand: "Cloudsoft" },
    fallback: { product_id: "toilet-paper-everyroll", brand: "Everyroll" },
    maxPrice: 18,
    pace: 21,
    daysLeftAtStart: 12,
    usualPrice: 13.99,
  },
  {
    item_id: "paper-towels",
    autonomy: { mode: "ask", forDays: null, deliveryDays: null },
    preferred: { product_id: "paper-towels-sheetwise", brand: "Sheetwise" },
    fallback: { product_id: "paper-towels-rollgood", brand: "Rollgood" },
    maxPrice: 15,
    pace: 14,
    daysLeftAtStart: 13,
    usualPrice: 11.99,
  },
  {
    item_id: "dog-food",
    autonomy: { mode: "ask", forDays: null, deliveryDays: null },
    preferred: { product_id: "dog-food-trailhound", brand: "Trailhound" },
    fallback: { product_id: "dog-food-barkley", brand: "Barkley" },
    maxPrice: 50,
    pace: 30,
    daysLeftAtStart: 20,
    usualPrice: 44.99,
  },
];

/**
 * Days the house went without before each restock — small and irregular, so
 * the history does not look machine-made. Always less than a cycle, so every
 * "we're out" falls before the next delivery and the events stay in order.
 */
const DAYS_WITHOUT = [1, 3, 2, 1, 2];

/**
 * Five past refills of the preferred product, each ending in "we're out",
 * then the pack currently in use — timed to leave `daysLeftAtStart`. Five,
 * not three: with three, the opening forecast's range was so wide (0-16 days
 * for detergent) that it read as a shrug.
 */
export function demoHistory(setup: DemoItemSetup, start = DEMO_START_DAY): HouseholdEvent[] {
  const lastArrival = start - (setup.pace - setup.daysLeftAtStart);
  const events: HouseholdEvent[] = [];
  for (let k = DAYS_WITHOUT.length; k >= 1; k--) {
    const arrival = lastArrival - k * setup.pace;
    events.push({
      kind: "purchase",
      day: arrival,
      packs: 1,
      by: "household",
      product_id: setup.preferred.product_id,
      price: setup.usualPrice,
    });
    events.push({ kind: "runout", day: arrival + setup.pace - (DAYS_WITHOUT[k - 1] ?? 1) });
  }
  events.push({
    kind: "purchase",
    day: lastArrival,
    packs: 1,
    by: "household",
    product_id: setup.preferred.product_id,
    price: setup.usualPrice,
  });
  return events;
}

export function demoItemName(itemId: string): string {
  return DEMO_ITEMS.find((i) => i.item_id === itemId)?.name ?? itemId;
}
