import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import { VouchStore } from "@vouch/db";
import { Merchant } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import type { UcpCheckoutSession, UcpCreateCheckoutRequest, UcpUpdateCheckoutRequest } from "@vouch/shared";
import { HouseholdAgent, VouchService } from "@vouch/mcp-server";
import type { MerchantClient } from "@vouch/mcp-server";

/**
 * The household agent acts when nobody asked. These tests are about the
 * properties that make that acceptable, not about the forecast's arithmetic
 * (packages/household tests that): it buys only through the gate, it never
 * orders twice, it waits for the household when the gate says wait, it
 * learns from what the household tells it, and the agent's own opinion can
 * never raise the number the gate compares.
 */

class RecordingMerchant implements MerchantClient {
  readonly completed: string[] = [];
  private readonly merchant = new Merchant();
  async createSession(r: UcpCreateCheckoutRequest): Promise<UcpCheckoutSession> {
    return this.merchant.createSession(r);
  }
  async updateSession(id: string, r: UcpUpdateCheckoutRequest): Promise<UcpCheckoutSession> {
    return this.merchant.updateSession(id, r);
  }
  async completeSession(id: string): Promise<UcpCheckoutSession> {
    const session = this.merchant.completeSession(id);
    this.completed.push(session.line_items[0]!.item.id);
    return session;
  }
  async cancelSession(id: string): Promise<UcpCheckoutSession> {
    return this.merchant.cancelSession(id);
  }
  async listProducts() {
    return this.merchant.catalog.list();
  }
  setPrice(id: string, price: number) {
    this.merchant.catalog.setPriceMajor(id, price);
  }
}

interface Rig {
  store: VouchStore;
  service: VouchService;
  agent: HouseholdAgent;
  merchant: RecordingMerchant;
}

function rig(): Rig {
  const store = VouchStore.open(":memory:");
  const merchant = new RecordingMerchant();
  const service = new VouchService({
    store,
    merchant,
    reasoning: new RuleBasedReasoningProvider(),
    physicalEvidence: new MockRingProvider(),
  });
  const agent = new HouseholdAgent({ store, service });
  agent.setUpDemo();
  return { store, service, agent, merchant };
}

const item = (r: Rig, id: string) => r.agent.pantry().find((p) => p.item_id === id)!;

describe("the demo household", () => {
  it("opens with detergent close to running out and dog food a fortnight away", () => {
    const r = rig();
    const detergent = item(r, "detergent").forecast;
    const dogFood = item(r, "dog-food").forecast;
    assert.ok(detergent.daysLeft!.median < 5, `detergent: ${detergent.daysLeft!.median}`);
    assert.ok(dogFood.daysLeft!.median > 10, `dog food: ${dogFood.daysLeft!.median}`);
    assert.equal(r.service.listMandates().length, 6, "one mandate per item");
  });
});

describe("buying when nobody asked", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  it("proposes detergent on its own as it runs low — through the gate, and it completes", async () => {
    const { actions } = await r.agent.advance(3);
    const proposal = actions.find((a) => a.item_id === "detergent" && a.kind === "proposed");
    assert.ok(proposal && proposal.kind === "proposed", `no detergent proposal in ${JSON.stringify(actions)}`);
    assert.equal(proposal.outcome, "completed");
    assert.ok(r.merchant.completed.includes("detergent-brand-a"), "your usual product, bought through a real checkout");

    const vouch = r.service.listVouches({ limit: 50 }).find((v) => v.vouch_id === proposal.vouch_id)!;
    assert.equal(vouch.household?.initiated_by, "forecast", "the record must say nobody asked");
    assert.equal(vouch.authority.confidence_basis?.agent_claimed, null, "no agent opinion was involved");
    assert.equal(vouch.authority.confidence_basis?.notes.product, "the product you usually buy");
    assert.ok(vouch.authority.confidence_score! >= 0.85);
  });

  it("never orders the same item twice while one is on the way", async () => {
    const { actions } = await r.agent.advance(4);
    const detergentOrders = actions.filter((a) => a.item_id === "detergent" && a.kind === "proposed");
    assert.equal(detergentOrders.length, 1, JSON.stringify(detergentOrders));
  });

  it("waits for the household when the gate holds a purchase, instead of asking again every day", async () => {
    // The usual product jumps well past the limit: the gate must hold it.
    r.merchant.setPrice("detergent-brand-a", 19.99);
    const { actions } = await r.agent.advance(6);
    const proposals = actions.filter((a) => a.item_id === "detergent" && a.kind === "proposed");
    assert.equal(proposals.length, 1, "one held purchase, then quiet until the household decides");
    assert.equal(proposals[0]!.kind === "proposed" && proposals[0]!.outcome, "held_for_approval");
    assert.ok(item(r, "detergent").awaitingApproval);
    assert.ok(!r.merchant.completed.includes("detergent-brand-a"), "held means no order");
  });

  it("after 'keep it blocked', rests the item instead of proposing the same thing tomorrow", async () => {
    r.merchant.setPrice("detergent-brand-a", 19.99);
    const first = await r.agent.advance(3);
    const held = first.actions.find((a) => a.item_id === "detergent" && a.kind === "proposed")!;
    assert.ok(held.kind === "proposed" && held.outcome === "held_for_approval");
    await r.service.declinePurchase(held.vouch_id);
    const next = await r.agent.advance(2);
    assert.ok(!next.actions.some((a) => a.item_id === "detergent"), JSON.stringify(next.actions));
  });

  it("does nothing for an item whose mandate is paused", async () => {
    r.service.pauseMandate("m_detergent");
    const { actions } = await r.agent.advance(5);
    assert.equal(actions.filter((a) => a.item_id === "detergent").length, 0);
  });

  it("learns from a purchase approved later, like any other", async () => {
    r.merchant.setPrice("detergent-brand-a", 19.99);
    const { actions } = await r.agent.advance(3);
    const held = actions.find((a) => a.kind === "proposed" && a.item_id === "detergent")!;
    assert.ok(held.kind === "proposed");
    await r.service.approvePurchase(held.vouch_id);
    assert.equal(item(r, "detergent").awaitingApproval, null);
    assert.equal(item(r, "detergent").forecast.orderOnTheWay, true, "the approved order is now on its way");
  });
});

describe("what the household tells it", () => {
  it("'we're out' on an Auto item makes it buy the next day", async () => {
    const r = rig();
    r.agent.record("toilet-paper", { kind: "runout" });
    const { actions } = await r.agent.advance(1);
    assert.ok(actions.some((a) => a.item_id === "toilet-paper" && a.kind === "proposed"), JSON.stringify(actions));
  });

  it("'we're out' on an Ask item suggests an order instead of buying", async () => {
    // Dog food is in Ask mode in the demo: running out is a reason to ask
    // sooner, not permission to buy.
    const r = rig();
    r.agent.record("dog-food", { kind: "runout" });
    const { actions } = await r.agent.advance(1);
    assert.ok(actions.some((a) => a.item_id === "dog-food" && a.kind === "notified"));
    assert.ok(!actions.some((a) => a.item_id === "dog-food" && a.kind === "proposed"));
  });

  it("an answer to 'how much is left?' clears the question", async () => {
    const r = rig();
    let asked: string | undefined;
    for (let i = 0; i < 20 && !asked; i++) {
      const { actions } = await r.agent.advance(1);
      asked = actions.find((a) => a.kind === "asked")?.item_id;
    }
    assert.ok(asked, "within twenty days some item should be worth one question");
    assert.notEqual(item(r, asked!).settings.pendingQuestionDay, null);
    r.agent.record(asked!, { kind: "level", packs: 0.5 });
    assert.equal(item(r, asked!).settings.pendingQuestionDay, null);
  });

  it("drops an open question once the item has been bought", async () => {
    // First run through the real stack: dish soap was asked about on day 101,
    // bought on day 102, and still showed the question — asking the household
    // about stock that was already being replaced.
    const r = rig();
    const actions: { item_id: string; kind: string }[] = [];
    for (let i = 0; i < 10; i++) actions.push(...(await r.agent.advance(1)).actions);
    for (const itemId of new Set(actions.filter((a) => a.kind === "proposed").map((a) => a.item_id))) {
      const p = item(r, itemId);
      if (p.forecast.orderOnTheWay) assert.equal(p.settings.pendingQuestionDay, null, `${itemId} still has a question`);
    }
  });

  it("refuses a nonsense answer rather than learning from it", () => {
    const r = rig();
    assert.throws(() => r.agent.record("coffee", { kind: "level", packs: -1 }), /between 0 and 10/);
  });
});

describe("modes: what the household has handed over, per item", () => {
  /** Advances a day at a time until `pred` is met, returning that day's actions. */
  async function until(r: Rig, pred: (a: { item_id: string; kind: string }) => boolean, maxDays = 40) {
    for (let i = 0; i < maxDays; i++) {
      const { actions } = await r.agent.advance(1);
      if (actions.some(pred)) return actions;
    }
    throw new Error("never happened");
  }

  it("the demo opens with all three modes, so one fast-forward shows each", () => {
    const r = rig();
    assert.equal(item(r, "detergent").autonomy?.mode, "auto");
    assert.equal(item(r, "coffee").autonomy?.mode, "ask");
    assert.equal(item(r, "dish-soap").autonomy?.mode, "remind");
  });

  it("Ask suggests a specific order and buys nothing until the household says yes", async () => {
    const r = rig();
    await until(r, (a) => a.item_id === "coffee" && a.kind === "notified");
    const notice = item(r, "coffee").settings.notice!;
    assert.equal(notice.kind, "ask");
    assert.equal(notice.product_id, "coffee-morning-ridge");
    assert.equal(notice.usual_price, 9.99);
    assert.ok(!r.merchant.completed.includes("coffee-morning-ridge"), "asking is not buying");

    const { result } = await r.agent.respond("coffee", { response: "order" });
    assert.equal(result?.outcome, "completed");
    assert.equal(result?.vouch.household, null, "the household asked — the record must not say the forecast did");
    assert.equal(item(r, "coffee").settings.notice, null);
  });

  it("Remind tells the household and names no order", async () => {
    const r = rig();
    await until(r, (a) => a.item_id === "dish-soap" && a.kind === "notified");
    assert.equal(item(r, "dish-soap").settings.notice?.kind, "remind");
    assert.ok(!r.merchant.completed.includes("dish-soap-clearwave"));
  });

  it("asks once per need, not every day", async () => {
    const r = rig();
    const all: { item_id: string; kind: string }[] = [];
    for (let i = 0; i < 12; i++) all.push(...(await r.agent.advance(1)).actions);
    assert.equal(all.filter((a) => a.item_id === "coffee" && a.kind === "notified").length, 1);
  });

  it("'not yet' rests for a few days instead of nagging", async () => {
    const r = rig();
    await until(r, (a) => a.item_id === "coffee" && a.kind === "notified");
    await r.agent.respond("coffee", { response: "not_yet" });
    const next = await r.agent.advance(2);
    assert.ok(!next.actions.some((a) => a.item_id === "coffee" && a.kind === "notified"));
  });

  it("'not until the 15th' stays quiet until then", async () => {
    const r = rig();
    await until(r, (a) => a.item_id === "coffee" && a.kind === "notified");
    const quietTo = r.agent.today() + 6;
    await r.agent.respond("coffee", { response: "snooze", until_day: quietTo });
    const next = await r.agent.advance(5);
    assert.ok(!next.actions.some((a) => a.item_id === "coffee"));
  });

  it("earns trust: four suggestions accepted as-is lead to an offer to take over, for 90 days", async () => {
    const r = rig();
    for (let n = 0; n < 4; n++) {
      await until(r, (a) => a.item_id === "coffee" && a.kind === "notified");
      await r.agent.respond("coffee", { response: "order" });
    }
    const offer = item(r, "coffee").settings.promotion;
    assert.ok(offer, "after four yeses it should offer to handle coffee on its own");
    assert.equal(item(r, "coffee").autonomy?.mode, "ask", "an offer is not a change: the household decides");

    await r.agent.respond("coffee", { response: "accept_promotion" });
    assert.equal(item(r, "coffee").autonomy?.mode, "auto");
    assert.equal(item(r, "coffee").autonomy?.until, offer.until, "handed over for a set time, not forever");
  });

  it("loses trust: a dispute demotes an Auto item to Ask at once", async () => {
    const r = rig();
    const actions = await until(r, (a) => a.item_id === "detergent" && a.kind === "proposed");
    const bought = actions.find((a) => a.item_id === "detergent" && a.kind === "proposed")!;
    assert.ok(bought.kind === "proposed");
    await r.service.recordDispute({ vouch_id: bought.vouch_id, reason: "wrong one" });
    const detergent = item(r, "detergent");
    assert.equal(detergent.autonomy?.mode, "ask");
    assert.match(detergent.settings.lastModeChange!.why, /disputed/);
  });

  it("expires: Auto with an end date steps down to Ask by itself", async () => {
    const r = rig();
    const actions = await until(r, (a) => a.item_id === "toilet-paper" && a.kind === "autonomy_expired", 65);
    assert.ok(actions.length > 0);
    assert.equal(item(r, "toilet-paper").autonomy?.mode, "ask");
  });

  it("honours a delivery window: weekend-only toilet paper is ordered to arrive on a weekend", async () => {
    const r = rig();
    const actions = await until(r, (a) => a.item_id === "toilet-paper" && a.kind === "proposed");
    const proposal = actions.find((a) => a.item_id === "toilet-paper" && a.kind === "proposed")!;
    assert.ok(proposal.kind === "proposed");
    const vouch = r.service.listVouches({ limit: 50 }).find((v) => v.vouch_id === proposal.vouch_id)!;
    const weekday = new Date(`${r.agent.dateOf(vouch.household!.delivery_day!)}T00:00:00Z`).getUTCDay();
    assert.ok(weekday === 0 || weekday === 6, `delivery day is weekday ${weekday}`);
  });

  it("the gate enforces the mode even if the loop got it wrong", async () => {
    // Pretend the household loop had a bug and tried to buy coffee (Ask mode)
    // on its own. The gate — not the loop — must hold it.
    const r = rig();
    const result = await r.service.proposePurchase({
      mandate_id: "m_coffee",
      product_id: "coffee-morning-ridge",
      brand: "Morning Ridge",
      quantity: 1,
      reason: ["running_low"],
      household: {
        item_id: "coffee",
        day: 101,
        need: { kind: "forecast", runoutRisk: 0.6, status: "stocked" },
        days_per_pack: 11,
        days_left: { low: 1, median: 2, high: 4 },
        runout_risk: 0.6,
        delivery_day: 103,
      },
    });
    assert.equal(result.outcome, "held_for_approval");
    assert.ok(result.vouch.authority.triggered_rules.includes("autonomy_not_granted"));
    assert.ok(!r.merchant.completed.includes("coffee-morning-ridge"));
  });
});

describe("the simulated doorbell", () => {
  it("can show a corroborated delivery — and refuses to be set when the doorbell is real", async () => {
    const r = rig();
    r.service.setDemoDoorbell("corroborated");
    const { actions } = await r.agent.advance(3);
    const bought = actions.find((a) => a.kind === "proposed" && a.outcome === "completed")!;
    assert.ok(bought && bought.kind === "proposed");
    const vouch = r.service.listVouches({ limit: 50 }).find((v) => v.vouch_id === bought.vouch_id)!;
    assert.equal(vouch.evidence.physical.correlation_status, "corroborated");
    assert.equal(vouch.evidence.physical.event_type, "motion_detected", "motion at the door — never 'delivered'");

    const real = new VouchService({
      store: VouchStore.open(":memory:"),
      merchant: new RecordingMerchant(),
      reasoning: new RuleBasedReasoningProvider(),
      physicalEvidence: { correlateDelivery: async () => ({ ring_event_id: null, correlation_status: "unconfirmed", event_type: null, classification: null }) },
    });
    assert.throws(() => real.setDemoDoorbell("corroborated"), /doorbell is real/);
  });
});

describe("the agent's opinion cannot raise the number the gate compares", () => {
  it("caps a claimed 0.99 at the evidence for a brand the household never approved", async () => {
    const r = rig();
    const result = await r.service.proposePurchase({
      mandate_id: "m_detergent",
      product_id: "detergent-brand-c",
      brand: "Brand C",
      quantity: 1,
      confidence: 0.99,
      reason: ["biggest_bottle"],
    });
    assert.equal(result.outcome, "held_for_approval");
    assert.equal(result.vouch.authority.confidence_basis?.agent_claimed, 0.99);
    assert.equal(result.vouch.authority.confidence_score, 0.6);
    assert.ok(result.vouch.authority.triggered_rules.includes("below_confidence_threshold"));
  });

  it("lets the agent admit doubt about something the evidence would allow", async () => {
    const r = rig();
    const result = await r.service.proposePurchase({
      mandate_id: "m_coffee",
      product_id: "coffee-morning-ridge",
      brand: "Morning Ridge",
      quantity: 1,
      confidence: 0.5,
      reason: ["not_sure_they_want_it"],
    });
    assert.equal(result.vouch.authority.confidence_score, 0.5);
    assert.equal(result.outcome, "held_for_approval");
  });
});
