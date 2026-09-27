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
  it("'we're out' makes it buy the next day", async () => {
    const r = rig();
    r.agent.record("dog-food", { kind: "runout" });
    const { actions } = await r.agent.advance(1);
    assert.ok(actions.some((a) => a.item_id === "dog-food" && a.kind === "proposed"));
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
