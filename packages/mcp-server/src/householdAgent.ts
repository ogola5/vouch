import type { VouchStore } from "@vouch/db";
import type { Mandate, Vouch } from "@vouch/shared";
import {
  DEMO_ITEMS,
  DEMO_SETUP,
  DEMO_START_DAY,
  demoHistory,
  forecast,
  type Forecast,
  type HouseholdEvent,
  type ItemProfile,
  type QuestionMode,
} from "@vouch/household";
import type { ProposePurchaseResult, VouchService } from "./service.ts";

/**
 * The agent that acts when nobody asked: each day, for each tracked item,
 * forecast when the house runs out and — when it is time — propose the
 * purchase through the SAME gate a chat request goes through.
 *
 * WHAT THIS IS NOT. It is not a second path to an order. It holds no
 * merchant client and cannot complete a checkout; its only way to buy is
 * VouchService.proposePurchase, which runs the mandate gate before
 * `ready_for_complete -> completed` exactly as it does for the chat agent.
 * The forecast decides WHEN to ask the gate. Only the gate decides whether.
 *
 * Its clock is the household's (household_meta 'today'), not the wall
 * clock, which is what lets the demo fast-forward a month in a click.
 */

export interface ItemSettings {
  questions: QuestionMode;
  /** The household's answer to "how often do you buy this?", in days. */
  answeredDaysPerPack?: number;
  /** Set when the forecast wants to ask "roughly how much is left?"; cleared by any answer. */
  pendingQuestionDay: number | null;
}

export type DayAction =
  | { day: number; item_id: string; kind: "proposed"; outcome: ProposePurchaseResult["outcome"]; vouch_id: string }
  | { day: number; item_id: string; kind: "asked" }
  | { day: number; item_id: string; kind: "failed"; error: string };

export interface PantryItem {
  item_id: string;
  name: string;
  settings: ItemSettings;
  mandate: Pick<Mandate, "mandate_id" | "goal" | "status" | "confidence_threshold" | "baseline_confidence_threshold"> & {
    max_price: number | null;
  } | null;
  forecast: Forecast;
  /** A purchase for this item is held and waiting for the household. */
  awaitingApproval: string | null;
  lastPurchase: { day: number; product_id: string | null; by: "household" | "agent" } | null;
}

const MAX_ADVANCE_DAYS = 60;

export class HouseholdAgent {
  private readonly store: VouchStore;
  private readonly service: VouchService;

  constructor(deps: { store: VouchStore; service: VouchService }) {
    this.store = deps.store;
    this.service = deps.service;
    // Learn from every completed purchase, however it was made.
    this.service.setPurchaseListener((completed) => this.recordPurchase(completed));
  }

  isSetUp(): boolean {
    return this.store.getHouseholdMeta("today") !== null;
  }

  today(): number {
    const raw = this.store.getHouseholdMeta("today");
    return raw === null ? DEMO_START_DAY : Number(raw);
  }

  /**
   * Loads the demo household: six items, a mandate for each, and an authored
   * history (packages/household/src/demo.ts — simulated, and labelled so).
   * Existing Vouches are kept; the household ledger starts fresh.
   */
  setUpDemo(): PantryItem[] {
    this.store.clearHousehold();
    for (const setup of DEMO_SETUP) {
      const settings: ItemSettings = { questions: "once-per-pack", pendingQuestionDay: null };
      this.store.saveHouseholdItem(setup.item_id, settings);
      for (const event of demoHistory(setup)) this.store.appendHouseholdEvent(setup.item_id, event);

      const mandateId = `m_${setup.item_id.replace(/-/g, "_")}`;
      const constraints = {
        item_id: setup.item_id,
        max_price: setup.maxPrice,
        preferred_brand: setup.preferred.brand,
        fallback_brand: setup.fallback.brand,
      };
      const existing = this.service.getMandate(mandateId);
      if (existing) {
        // The console's "demo mandate" for detergent predates items; link it
        // rather than creating a second detergent mandate.
        this.service.updateMandate(mandateId, { constraints: { ...existing.constraints, ...constraints } });
      } else {
        this.service.createMandate({
          mandate_id: mandateId,
          goal: `Keep ${DEMO_ITEMS.find((i) => i.item_id === setup.item_id)!.name.toLowerCase()} stocked`,
          constraints,
          requires_approval_if: ["price > max_price", "new_brand"],
          authority_type: "explicit",
          confidence_threshold: 0.85,
        });
      }
    }
    this.store.setHouseholdMeta("today", String(DEMO_START_DAY));
    return this.pantry();
  }

  pantry(): PantryItem[] {
    const today = this.today();
    return this.store.listHouseholdItemIds().map((itemId) => {
      const settings = this.settings(itemId);
      const events = this.events(itemId);
      const mandate = this.mandateFor(itemId);
      const purchases = events.filter((e): e is Extract<HouseholdEvent, { kind: "purchase" }> => e.kind === "purchase" && e.day <= today);
      const last = purchases[purchases.length - 1] ?? null;
      return {
        item_id: itemId,
        name: this.profile(itemId).name,
        settings,
        mandate: mandate
          ? {
              mandate_id: mandate.mandate_id,
              goal: mandate.goal,
              status: mandate.status,
              confidence_threshold: mandate.confidence_threshold,
              baseline_confidence_threshold: mandate.baseline_confidence_threshold,
              max_price: typeof mandate.constraints.max_price === "number" ? mandate.constraints.max_price : null,
            }
          : null,
        forecast: forecast(this.profile(itemId), events, today, { questions: settings.questions }),
        awaitingApproval: mandate ? this.heldVouchFor(mandate) : null,
        lastPurchase: last ? { day: last.day, product_id: last.product_id ?? null, by: last.by } : null,
      };
    });
  }

  /** Moves the household's clock forward a day at a time, acting on each day as it comes. */
  async advance(days: number): Promise<{ today: number; actions: DayAction[] }> {
    const steps = Math.max(1, Math.min(MAX_ADVANCE_DAYS, Math.floor(days)));
    const actions: DayAction[] = [];
    for (let i = 0; i < steps; i++) {
      const day = this.today() + 1;
      this.store.setHouseholdMeta("today", String(day));
      actions.push(...(await this.act(day)));
    }
    return { today: this.today(), actions };
  }

  /** One day's decisions, for every tracked item. */
  async act(day: number): Promise<DayAction[]> {
    const actions: DayAction[] = [];
    for (const itemId of this.store.listHouseholdItemIds()) {
      const mandate = this.mandateFor(itemId);
      // No mandate, or a paused one: the household has not given authority.
      if (!mandate || mandate.status === "paused") continue;
      // One question at a time: a held purchase is waiting for the household.
      if (this.heldVouchFor(mandate)) continue;

      const settings = this.settings(itemId);
      const profile = this.profile(itemId);
      const f = forecast(profile, this.events(itemId), day, { questions: settings.questions });

      if (f.shouldPropose) {
        const product = this.chooseProduct(itemId);
        try {
          const result = await this.service.proposePurchase({
            mandate_id: mandate.mandate_id,
            product_id: product.product_id,
            brand: product.brand,
            quantity: 1,
            reason: ["running_low", product.fit],
            household: {
              item_id: itemId,
              day,
              need: { kind: "forecast", runoutRisk: f.runoutRisk, status: f.status === "out" ? "out" : "stocked" },
              days_per_pack: f.pace.daysPerPack,
              days_left: f.daysLeft,
              runout_risk: f.runoutRisk,
            },
          });
          actions.push({ day, item_id: itemId, kind: "proposed", outcome: result.outcome, vouch_id: result.vouch.vouch_id });
        } catch (error) {
          actions.push({ day, item_id: itemId, kind: "failed", error: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }

      if (f.shouldAsk && settings.pendingQuestionDay === null) {
        this.store.saveHouseholdItem(itemId, { ...settings, pendingQuestionDay: day });
        actions.push({ day, item_id: itemId, kind: "asked" });
      }
    }
    return actions;
  }

  /**
   * What the household tells it: "we're out", "we still have plenty", or an
   * answer to "roughly how much is left?". Information, not authority — it
   * needs no passkey (BUILD_PLAN.md §3b, W3 design).
   */
  record(itemId: string, statement: { kind: "runout" } | { kind: "plenty" } | { kind: "level"; packs: number }): PantryItem {
    if (!this.store.listHouseholdItemIds().includes(itemId)) throw new Error(`No tracked item "${itemId}"`);
    if (statement.kind === "level" && !(statement.packs >= 0 && statement.packs <= 10)) {
      throw new Error(`"How much is left" must be between 0 and 10 packs, got ${statement.packs}`);
    }
    this.store.appendHouseholdEvent(itemId, { ...statement, day: this.today() });
    this.store.saveHouseholdItem(itemId, { ...this.settings(itemId), pendingQuestionDay: null });
    return this.pantry().find((p) => p.item_id === itemId)!;
  }

  /* ---------------------------------------------------------------------- */

  private recordPurchase(completed: { vouch: Vouch; mandate: Mandate; quantity: number; productId: string | null }) {
    const itemId = completed.mandate.constraints.item_id;
    if (typeof itemId !== "string" || !this.isSetUp()) return;
    const lead = this.profile(itemId).leadDays;
    const event: HouseholdEvent = {
      kind: "purchase",
      // Stock is usable when it arrives, not when it is ordered.
      day: this.today() + lead,
      packs: completed.quantity,
      // Bought because the forecast said so → the agent bought early, by
      // design, and it must not be read as "the house had run out".
      by: completed.vouch.household?.initiated_by === "forecast" ? "agent" : "household",
      product_id: completed.productId ?? undefined,
      price: completed.vouch.decision.price,
    };
    this.store.appendHouseholdEvent(itemId, event);
    // A purchase answers the question "how much is left?" was asking for:
    // leaving it open would ask the household about stock that is already
    // being replaced. (Found in the first run through the real stack.)
    this.store.saveHouseholdItem(itemId, { ...this.settings(itemId), pendingQuestionDay: null });
  }

  /** The usual product if there is one, else the preferred brand. */
  private chooseProduct(itemId: string): { product_id: string; brand: string; fit: string } {
    const setup = DEMO_SETUP.find((s) => s.item_id === itemId)!;
    const purchases = this.events(itemId).filter((e) => e.kind === "purchase" && e.product_id);
    const usual = purchases[purchases.length - 1];
    if (usual && usual.kind === "purchase" && usual.product_id === setup.fallback.product_id) {
      return { product_id: setup.fallback.product_id, brand: setup.fallback.brand, fit: "usual_product" };
    }
    return {
      product_id: setup.preferred.product_id,
      brand: setup.preferred.brand,
      fit: usual ? "usual_product" : "preferred_brand",
    };
  }

  private heldVouchFor(mandate: Mandate): string | null {
    return (
      this.service
        .listVouches({ mandate_id: mandate.mandate_id, limit: 20 })
        .find((v) => v.action.status === "PendingApproval")?.vouch_id ?? null
    );
  }

  private mandateFor(itemId: string): Mandate | undefined {
    return this.service.listMandates().find((m) => m.constraints.item_id === itemId);
  }

  private settings(itemId: string): ItemSettings {
    const raw = this.store.getHouseholdItem(itemId) as Partial<ItemSettings> | null;
    return {
      questions: raw?.questions ?? "once-per-pack",
      answeredDaysPerPack: raw?.answeredDaysPerPack,
      pendingQuestionDay: raw?.pendingQuestionDay ?? null,
    };
  }

  private profile(itemId: string): ItemProfile {
    const base = DEMO_ITEMS.find((i) => i.item_id === itemId);
    if (!base) throw new Error(`Unknown household item "${itemId}"`);
    const answered = this.settings(itemId).answeredDaysPerPack;
    return answered ? { ...base, answeredDaysPerPack: answered } : { ...base };
  }

  private events(itemId: string): HouseholdEvent[] {
    // Checked on the way out of the database, the same fail-loudly instinct
    // as the Zod re-parse on mandates and Vouches.
    return this.store.listHouseholdEvents(itemId).map((raw) => {
      const e = raw as HouseholdEvent;
      if (typeof e?.day !== "number" || !["purchase", "runout", "plenty", "level"].includes(e.kind)) {
        throw new Error(`Malformed household event for "${itemId}": ${JSON.stringify(raw)}`);
      }
      return e;
    });
  }
}
