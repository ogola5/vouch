/**
 * The household's consumables, and a starting guess for each.
 *
 * THE STARTING GUESSES ARE ASSUMPTIONS, NOT DATA. They exist so a new item
 * has a forecast on day one; each is worth about two real refills (see
 * PRIOR_WEIGHT in forecast.ts), so the household's own history replaces it
 * quickly. Where the household answers "how often do you buy this?", that
 * answer replaces the guess outright. Never present these as measurements.
 */

export interface ItemProfile {
  item_id: string;
  name: string;
  /** Rough days one pack lasts a typical household. An assumption; see above. */
  defaultDaysPerPack: number;
  /** The household's answer to "how often do you buy this?", in days. */
  answeredDaysPerPack?: number;
  /** Days from ordering to it arriving at the door. */
  leadDays: number;
}

export const DEMO_ITEMS: readonly ItemProfile[] = [
  { item_id: "detergent", name: "Laundry detergent", defaultDaysPerPack: 30, leadDays: 2 },
  { item_id: "dish-soap", name: "Dish soap", defaultDaysPerPack: 21, leadDays: 2 },
  { item_id: "paper-towels", name: "Paper towels", defaultDaysPerPack: 14, leadDays: 2 },
  { item_id: "toilet-paper", name: "Toilet paper", defaultDaysPerPack: 21, leadDays: 2 },
  { item_id: "dog-food", name: "Dog food", defaultDaysPerPack: 30, leadDays: 2 },
  { item_id: "coffee", name: "Coffee", defaultDaysPerPack: 14, leadDays: 2 },
];
