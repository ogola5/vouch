import type { VouchStore } from "@vouch/db";
import type { Autonomy, AutonomyMode, Mandate, Vouch } from "@vouch/shared";
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
 * The household agent: each day, for each tracked item, works out whether it
 * is running low — and then does what the household has ALLOWED for that
 * item, and nothing more:
 *
 *   remind  tell them it is running low
 *   ask     suggest a specific order and wait for a yes   (the default)
 *   auto    buy within the mandate's limits, then tell them
 *
 * WHAT THIS IS NOT. It is not a second path to an order. It holds no
 * merchant client; its only way to buy is VouchService.proposePurchase — the
 * same gate a chat request goes through — and for anything it starts on its
 * own, the gate ALSO checks the mandate's autonomy. So if this loop ever got
 * a mode wrong, the gate would still hold the purchase.
 *
 * TRUST MOVES, in both directions (BUILD_PLAN.md §3b, step 4):
 *   earned   four suggestions accepted as-is in a row → it offers to handle
 *            the item on its own for 90 days (accepting widens authority:
 *            W3 puts a passkey on it)
 *   lost     a dispute demotes Auto to Ask at once — narrowing needs no proof
 *   expired  Auto with an end date steps down to Ask by itself
 *
 * Its clock is the household's (household_meta 'today'), not the wall
 * clock, which is what lets the demo fast-forward a month in a click.
 */

/** Something waiting for the household to answer. At most one per item. */
export interface Notice {
  kind: "remind" | "ask";
  day: number;
  product_id: string;
  brand: string;
  /** What the household usually pays for it; the gate reads the real price at order time. */
  usual_price: number | null;
  runout_risk: number;
  days_left: { low: number; median: number; high: number } | null;
  /** The day an order placed now would arrive — inside the delivery window. */
  delivery_day: number;
}

export interface ItemSettings {
  questions: QuestionMode;
  /** The household's answer to "how often do you buy this?", in days. */
  answeredDaysPerPack?: number;
  /** Set when the forecast wants to ask "roughly how much is left?"; cleared by any answer. */
  pendingQuestionDay: number | null;
  notice: Notice | null;
  /** "Not yet" or "not until the 15th": no notices before this day. */
  quietUntil: number | null;
  /** Suggestions accepted exactly as offered, in a row. */
  acceptedInARow: number;
  /** An offer to switch to Auto, waiting for the household. */
  promotion: { day: number; until: string } | null;
  /** The last time the mode changed, and why — shown to the household. */
  lastModeChange: { day: number; from: AutonomyMode; to: AutonomyMode; why: string } | null;
}

const DEFAULT_SETTINGS: ItemSettings = {
  questions: "once-per-pack",
  pendingQuestionDay: null,
  notice: null,
  quietUntil: null,
  acceptedInARow: 0,
  promotion: null,
  lastModeChange: null,
};

export type DayAction =
  | { day: number; item_id: string; kind: "proposed"; outcome: ProposePurchaseResult["outcome"]; vouch_id: string }
  | { day: number; item_id: string; kind: "notified"; mode: "remind" | "ask" }
  | { day: number; item_id: string; kind: "asked" }
  | { day: number; item_id: string; kind: "autonomy_expired" }
  | { day: number; item_id: string; kind: "failed"; error: string };

export type NoticeResponse =
  | { response: "order" }
  | { response: "not_yet" }
  | { response: "snooze"; until_day: number }
  | { response: "accept_promotion" }
  | { response: "decline_promotion" };

export interface PantryItem {
  item_id: string;
  name: string;
  settings: ItemSettings;
  autonomy: Autonomy | null;
  mandate:
    | (Pick<Mandate, "mandate_id" | "goal" | "status" | "confidence_threshold" | "baseline_confidence_threshold"> & {
        max_price: number | null;
      })
    | null;
  forecast: Forecast;
  /** A purchase for this item is held and waiting for the household. */
  awaitingApproval: string | null;
  lastPurchase: { day: number; product_id: string | null; by: "household" | "agent" } | null;
}

const MAX_ADVANCE_DAYS = 60;
const PROMOTE_AFTER_ACCEPTED = 4;
const PROMOTION_DAYS = 90;
const NOT_YET_QUIET_DAYS = 3;
const DAY_MS = 86_400_000;

export class HouseholdAgent {
  private readonly store: VouchStore;
  private readonly service: VouchService;

  constructor(deps: { store: VouchStore; service: VouchService }) {
    this.store = deps.store;
    this.service = deps.service;
    // Learn from every completed purchase, however it was made; lose trust on
    // a dispute; and give the whole system one clock once a household exists.
    this.service.setPurchaseListener((completed) => this.recordPurchase(completed));
    this.service.setDisputeListener((disputed) => this.onDispute(disputed.mandate));
    this.service.setClock(() => (this.isSetUp() ? this.currentDate() : new Date()));
  }

  isSetUp(): boolean {
    return this.store.getHouseholdMeta("today") !== null;
  }

  today(): number {
    const raw = this.store.getHouseholdMeta("today");
    return raw === null ? DEMO_START_DAY : Number(raw);
  }

  /** The calendar date of a household day, YYYY-MM-DD. */
  dateOf(day: number): string {
    const epoch = this.store.getHouseholdMeta("epoch") ?? "2026-01-01";
    return new Date(Date.parse(`${epoch}T00:00:00Z`) + day * DAY_MS).toISOString().slice(0, 10);
  }

  /** "Now" on the household clock: its date, at the wall clock's time of day. */
  currentDate(): Date {
    const now = new Date();
    const msIntoDay = now.getTime() - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    return new Date(Date.parse(`${this.dateOf(this.today())}T00:00:00Z`) + msIntoDay);
  }

  /**
   * Loads the demo household: six items in three different modes, a mandate
   * for each, and an authored history (packages/household/src/demo.ts —
   * simulated, and labelled so). Day 100 is today's real date. Existing
   * Vouches are kept; the household ledger starts fresh.
   */
  setUpDemo(): PantryItem[] {
    this.store.clearHousehold();
    const todayReal = new Date().toISOString().slice(0, 10);
    const epoch = new Date(Date.parse(`${todayReal}T00:00:00Z`) - DEMO_START_DAY * DAY_MS).toISOString().slice(0, 10);
    this.store.setHouseholdMeta("epoch", epoch);

    for (const setup of DEMO_SETUP) {
      this.saveSettings(setup.item_id, { ...DEFAULT_SETTINGS });
      for (const event of demoHistory(setup)) this.store.appendHouseholdEvent(setup.item_id, event);

      const autonomy: Autonomy = {
        mode: setup.autonomy.mode,
        until: setup.autonomy.forDays === null ? null : this.dateOf(DEMO_START_DAY + setup.autonomy.forDays),
        delivery_days: setup.autonomy.deliveryDays,
      };
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
        this.service.updateMandate(mandateId, { constraints: { ...existing.constraints, ...constraints }, autonomy });
      } else {
        this.service.createMandate({
          mandate_id: mandateId,
          goal: `Keep ${DEMO_ITEMS.find((i) => i.item_id === setup.item_id)!.name.toLowerCase()} stocked`,
          constraints,
          requires_approval_if: ["price > max_price", "new_brand"],
          authority_type: "explicit",
          confidence_threshold: 0.85,
          autonomy,
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
      const purchases = events.filter(
        (e): e is Extract<HouseholdEvent, { kind: "purchase" }> => e.kind === "purchase" && e.day <= today
      );
      const last = purchases[purchases.length - 1] ?? null;
      return {
        item_id: itemId,
        name: this.baseProfile(itemId).name,
        settings,
        autonomy: mandate?.autonomy ?? null,
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
        forecast: forecast(this.profile(itemId, today), events, today, { questions: settings.questions }),
        awaitingApproval: mandate ? this.heldVouchFor(mandate) : null,
        lastPurchase: last ? { day: last.day, product_id: last.product_id ?? null, by: last.by } : null,
      };
    });
  }

  /** Moves the household's clock forward a day at a time, acting on each day as it comes. */
  async advance(days: number): Promise<{ today: number; date: string; actions: DayAction[] }> {
    const steps = Math.max(1, Math.min(MAX_ADVANCE_DAYS, Math.floor(days)));
    const actions: DayAction[] = [];
    for (let i = 0; i < steps; i++) {
      const day = this.today() + 1;
      this.store.setHouseholdMeta("today", String(day));
      actions.push(...(await this.act(day)));
    }
    return { today: this.today(), date: this.dateOf(this.today()), actions };
  }

  /** One day's decisions, for every tracked item. */
  async act(day: number): Promise<DayAction[]> {
    const actions: DayAction[] = [];
    for (const itemId of this.store.listHouseholdItemIds()) {
      let mandate = this.mandateFor(itemId);
      // No mandate, or a paused one: the household has not given authority.
      if (!mandate || mandate.status === "paused") continue;

      // Expired: Auto with an end date steps down to Ask by itself. The gate
      // would hold an unprompted purchase anyway; this makes the screen agree.
      if (mandate.autonomy.mode === "auto" && mandate.autonomy.until && this.dateOf(day) > mandate.autonomy.until) {
        mandate = this.setMode(itemId, { mode: "ask", until: null }, "the time you set for it ran out");
        actions.push({ day, item_id: itemId, kind: "autonomy_expired" });
      }

      // A held purchase is already waiting for the household.
      if (this.heldVouchFor(mandate)) continue;

      const settings = this.settings(itemId);
      if (settings.quietUntil !== null && day < settings.quietUntil) continue;

      const profile = this.profile(itemId, day, mandate);
      const f = forecast(profile, this.events(itemId), day, { questions: settings.questions });
      const deliveryDay = day + profile.leadDays;

      if (f.shouldPropose) {
        const product = this.chooseProduct(itemId);
        if (mandate.autonomy.mode === "auto") {
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
                delivery_day: deliveryDay,
              },
            });
            actions.push({ day, item_id: itemId, kind: "proposed", outcome: result.outcome, vouch_id: result.vouch.vouch_id });
          } catch (error) {
            actions.push({ day, item_id: itemId, kind: "failed", error: error instanceof Error ? error.message : String(error) });
          }
        } else if (settings.notice === null) {
          // Remind or Ask: tell the household, once per need — never daily.
          const kind = mandate.autonomy.mode === "remind" ? "remind" : "ask";
          this.saveSettings(itemId, {
            ...settings,
            pendingQuestionDay: null,
            notice: {
              kind,
              day,
              product_id: product.product_id,
              brand: product.brand,
              usual_price: this.usualPrice(itemId, product.product_id),
              runout_risk: f.runoutRisk,
              days_left: f.daysLeft,
              delivery_day: deliveryDay,
            },
          });
          actions.push({ day, item_id: itemId, kind: "notified", mode: kind });
        }
        continue;
      }

      if (f.shouldAsk && settings.pendingQuestionDay === null && settings.notice === null) {
        this.saveSettings(itemId, { ...settings, pendingQuestionDay: day });
        actions.push({ day, item_id: itemId, kind: "asked" });
      }
    }
    return actions;
  }

  /**
   * The household answers a notice or a promotion offer.
   *
   * "order" is the household asking for it, so it goes through the gate as a
   * REQUEST — authorised by the mandate's limits, needing no passkey (owner's
   * decision). "accept_promotion" widens authority; W3 will require a passkey
   * for it. Everything else only narrows or waits, and needs nothing.
   */
  async respond(itemId: string, answer: NoticeResponse): Promise<{ item: PantryItem; result?: ProposePurchaseResult }> {
    this.requireItem(itemId);
    const settings = this.settings(itemId);
    const today = this.today();
    const mandate = this.mandateFor(itemId);
    if (!mandate) throw new Error(`"${itemId}" has no mandate`);

    if (answer.response === "order") {
      const notice = settings.notice;
      const product = notice ? { product_id: notice.product_id, brand: notice.brand } : this.chooseProduct(itemId);
      const result = await this.service.proposePurchase({
        mandate_id: mandate.mandate_id,
        product_id: product.product_id,
        brand: product.brand,
        quantity: 1,
        reason: ["you_asked", "running_low"],
        origin: { started_by: "household" },
      });
      // Accepted as offered, and it went through: one more reason to trust it.
      const accepted = notice?.kind === "ask" && result.outcome === "completed" ? settings.acceptedInARow + 1 : 0;
      const offer =
        accepted >= PROMOTE_AFTER_ACCEPTED && mandate.autonomy.mode === "ask" && settings.promotion === null
          ? { day: today, until: this.dateOf(today + PROMOTION_DAYS) }
          : settings.promotion;
      this.saveSettings(itemId, { ...this.settings(itemId), notice: null, acceptedInARow: accepted, promotion: offer });
      return { item: this.item(itemId), result };
    }

    if (answer.response === "not_yet") {
      // Asked too early: rest a few days rather than nag, and do not count
      // it as agreement.
      this.saveSettings(itemId, { ...settings, notice: null, quietUntil: today + NOT_YET_QUIET_DAYS, acceptedInARow: 0 });
      return { item: this.item(itemId) };
    }

    if (answer.response === "snooze") {
      if (!(answer.until_day > today)) throw new Error("Snooze until a day after today");
      this.saveSettings(itemId, { ...settings, notice: null, quietUntil: answer.until_day });
      return { item: this.item(itemId) };
    }

    if (answer.response === "accept_promotion") {
      if (!settings.promotion) throw new Error(`No offer to hand over "${itemId}" is waiting`);
      this.setMode(itemId, { mode: "auto", until: settings.promotion.until }, "you accepted after saying yes four times in a row");
      this.saveSettings(itemId, { ...this.settings(itemId), promotion: null });
      return { item: this.item(itemId) };
    }

    this.saveSettings(itemId, { ...settings, promotion: null, acceptedInARow: 0 });
    return { item: this.item(itemId) };
  }

  /**
   * The household sets an item's mode directly: Remind, Ask, Auto, or Auto
   * until a date, and its delivery days. Moving TOWARDS Auto widens authority
   * (W3: passkey); moving away from it only narrows.
   */
  setItemMode(itemId: string, autonomy: Partial<Autonomy>): PantryItem {
    this.requireItem(itemId);
    this.setMode(itemId, autonomy, "you changed it");
    this.saveSettings(itemId, { ...this.settings(itemId), notice: null });
    return this.item(itemId);
  }

  /**
   * What the household tells it: "we're out", "we still have plenty", or an
   * answer to "roughly how much is left?". Information, not authority — it
   * needs no passkey.
   */
  record(itemId: string, statement: { kind: "runout" } | { kind: "plenty" } | { kind: "level"; packs: number }): PantryItem {
    this.requireItem(itemId);
    if (statement.kind === "level" && !(statement.packs >= 0 && statement.packs <= 10)) {
      throw new Error(`"How much is left" must be between 0 and 10 packs, got ${statement.packs}`);
    }
    this.store.appendHouseholdEvent(itemId, { ...statement, day: this.today() });
    // "We're out" ends any rest the household asked for: they need it now.
    const quietUntil = statement.kind === "runout" ? null : this.settings(itemId).quietUntil;
    this.saveSettings(itemId, { ...this.settings(itemId), pendingQuestionDay: null, quietUntil });
    return this.item(itemId);
  }

  /* ---------------------------------------------------------------------- */

  private setMode(itemId: string, change: Partial<Autonomy>, why: string): Mandate {
    const mandate = this.mandateFor(itemId);
    if (!mandate) throw new Error(`"${itemId}" has no mandate`);
    const next: Autonomy = { ...mandate.autonomy, ...change };
    const updated = this.service.updateMandate(mandate.mandate_id, { autonomy: next });
    if (next.mode !== mandate.autonomy.mode) {
      this.saveSettings(itemId, {
        ...this.settings(itemId),
        lastModeChange: { day: this.today(), from: mandate.autonomy.mode, to: next.mode, why },
      });
    }
    return updated;
  }

  private onDispute(mandate: Mandate): void {
    const itemId = mandate.constraints.item_id;
    if (typeof itemId !== "string" || !this.isSetUp()) return;
    this.saveSettings(itemId, { ...this.settings(itemId), acceptedInARow: 0, promotion: null });
    if (mandate.autonomy.mode === "auto") {
      this.setMode(itemId, { mode: "ask", until: null }, "you disputed a purchase it made");
    }
  }

  private recordPurchase(completed: { vouch: Vouch; mandate: Mandate; quantity: number; productId: string | null }) {
    const itemId = completed.mandate.constraints.item_id;
    if (typeof itemId !== "string" || !this.isSetUp()) return;
    const today = this.today();
    // Stock is usable when it arrives — on a day the household accepts
    // deliveries, and never before the order was actually placed: a purchase
    // held on day 101 and approved on day 104 cannot arrive on day 103.
    const earliest = today + this.profile(itemId, today, completed.mandate).leadDays;
    const event: HouseholdEvent = {
      kind: "purchase",
      day: Math.max(completed.vouch.household?.delivery_day ?? earliest, earliest),
      packs: completed.quantity,
      // Bought because the forecast said so → the agent bought early, by
      // design, and it must not be read as "the house had run out".
      by: completed.vouch.household?.initiated_by === "forecast" ? "agent" : "household",
      product_id: completed.productId ?? undefined,
      price: completed.vouch.decision.price,
    };
    this.store.appendHouseholdEvent(itemId, event);
    // A purchase answers what a notice or "how much is left?" was asking.
    this.saveSettings(itemId, { ...this.settings(itemId), pendingQuestionDay: null, notice: null });
  }

  /**
   * The item's profile for a given day, with the lead time stretched to the
   * next day a delivery may arrive. The forecast then buys early enough for
   * a weekend-only delivery to land before the house runs out.
   */
  private profile(itemId: string, day: number, mandate = this.mandateFor(itemId)): ItemProfile {
    const base = this.baseProfile(itemId);
    const allowed = mandate?.autonomy.delivery_days ?? null;
    if (!allowed) return base;
    let arrival = day + base.leadDays;
    for (let i = 0; i < 7 && !allowed.includes(this.weekday(arrival)); i++) arrival++;
    return { ...base, leadDays: arrival - day };
  }

  private baseProfile(itemId: string): ItemProfile {
    const base = DEMO_ITEMS.find((i) => i.item_id === itemId);
    if (!base) throw new Error(`Unknown household item "${itemId}"`);
    const answered = this.settings(itemId).answeredDaysPerPack;
    return answered ? { ...base, answeredDaysPerPack: answered } : { ...base };
  }

  private weekday(day: number): number {
    return new Date(`${this.dateOf(day)}T00:00:00Z`).getUTCDay();
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

  private usualPrice(itemId: string, productId: string): number | null {
    const prices = this.events(itemId)
      .filter((e) => e.kind === "purchase" && e.product_id === productId && typeof e.price === "number")
      .map((e) => (e.kind === "purchase" ? e.price! : 0));
    return prices.length ? prices[prices.length - 1]! : null;
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

  private item(itemId: string): PantryItem {
    return this.pantry().find((p) => p.item_id === itemId)!;
  }

  private requireItem(itemId: string): void {
    if (!this.store.listHouseholdItemIds().includes(itemId)) throw new Error(`No tracked item "${itemId}"`);
  }

  private settings(itemId: string): ItemSettings {
    const raw = this.store.getHouseholdItem(itemId) as Partial<ItemSettings> | null;
    return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  }

  private saveSettings(itemId: string, settings: ItemSettings): void {
    this.store.saveHouseholdItem(itemId, settings);
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
