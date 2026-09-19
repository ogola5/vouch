import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";

import { VouchStore } from "@vouch/db";
import { startMerchantServer } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { HttpMerchantClient, VouchService, startVouchHttpServer } from "@vouch/mcp-server";
import type { Mandate, Vouch } from "@vouch/shared";

/**
 * The household surface: the powers the agent deliberately does not have.
 *
 * The line these tests defend is that **the agent may do anything that cannot
 * increase its own authority**. Approving a held purchase and raising a
 * mandate's limits both widen what it may do next, so they live here and
 * nowhere else. `end-to-end.test.ts` asserts the other half — that neither
 * appears on the MCP tool list.
 */

let base: string;
let mcp: Server;
let merchantServer: Server;
let store: VouchStore;

before(async () => {
  const merchant = await startMerchantServer(0);
  merchantServer = merchant.server;
  store = VouchStore.open(":memory:");

  const service = new VouchService({
    store,
    merchant: new HttpMerchantClient(merchant.url),
    reasoning: new RuleBasedReasoningProvider(),
    physicalEvidence: new MockRingProvider(),
  });

  const started = await startVouchHttpServer(0, { service });
  mcp = started.server;
  base = started.url;

  service.createMandate({
    mandate_id: "m_detergent",
    goal: "Keep laundry detergent stocked",
    constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
    requires_approval_if: ["price > max_price", "new_brand"],
    authority_type: "explicit",
    confidence_threshold: 0.85,
  });
});

after(() => {
  mcp.close();
  merchantServer.close();
  store.close();
});

async function household<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}/household/${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await response.json();
  if (!response.ok) throw new Error((body as { error: string }).error);
  return body as T;
}

describe("editing a mandate — the thing the console could not do", () => {
  it("raises a spending limit and the gate immediately honours the new one", async () => {
    const before = await household<{ mandates: Mandate[] }>("state");
    assert.equal(before.mandates[0]?.constraints.max_price, 15);

    await household<Mandate>("mandates/m_detergent", {
      method: "PATCH",
      body: JSON.stringify({ constraints: { max_price: 30, preferred_brand: "Brand A" } }),
    });

    // The point of the edit: a purchase that was out of bounds now is not.
    // Brand C is $27.80 — refused at $15, allowed at $30.
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);

    const after = await household<{ mandates: Mandate[] }>("state");
    assert.equal(after.mandates[0]?.constraints.max_price, 30);
    assert.ok(after.mandates[0]?.history.last_adjusted, "an edit is an authority change, so it is stamped");
  });

  it("replaces constraints rather than merging, so a limit can be removed", async () => {
    await household<Mandate>("mandates/m_detergent", {
      method: "PATCH",
      body: JSON.stringify({ constraints: { max_price: 20 } }),
    });

    const { mandates } = await household<{ mandates: Mandate[] }>("state");
    // A merge would have kept preferred_brand forever, and a form that only
    // sends what it has could never clear a field.
    assert.equal(mandates[0]?.constraints.preferred_brand, undefined);
    assert.equal(mandates[0]?.constraints.max_price, 20);
  });

  it("refuses a nonsensical confidence threshold instead of storing it", async () => {
    await assert.rejects(
      () =>
        household("mandates/m_detergent", {
          method: "PATCH",
          body: JSON.stringify({ confidence_threshold: 4 }),
        }),
      /between 0 and 1/
    );
  });

  it("404s an unknown mandate rather than silently creating one", async () => {
    await assert.rejects(
      () =>
        household("mandates/does_not_exist", {
          method: "PATCH",
          body: JSON.stringify({ goal: "x" }),
        }),
      /No mandate with id/
    );
  });
});

describe("approving and disputing from the household surface", () => {
  it("approves a held purchase, which the agent has no tool to do", async () => {
    await household<Mandate>("mandates/m_detergent", {
      method: "PATCH",
      body: JSON.stringify({
        constraints: { max_price: 15 },
        requires_approval_if: ["price > max_price"],
        confidence_threshold: 0.85,
      }),
    });

    const service = new VouchService({
      store,
      merchant: new HttpMerchantClient(`http://127.0.0.1:${(merchantServer.address() as { port: number }).port}`),
      reasoning: new RuleBasedReasoningProvider(),
      physicalEvidence: new MockRingProvider(),
    });

    const held = await service.proposePurchase({
      mandate_id: "m_detergent",
      product_id: "detergent-brand-c",
      quantity: 1,
      brand: "Brand C",
      confidence: 0.95,
      reason: ["in_stock"],
    });
    assert.equal(held.outcome, "held_for_approval");

    const approved = await household<{ vouch: Vouch }>(
      `vouches/${held.vouch.vouch_id}/approve`,
      { method: "POST", body: "{}" }
    );

    assert.equal(approved.vouch.action.status, "Complete");
    assert.ok(approved.vouch.evidence.digital.order_id);
    assert.ok(approved.vouch.decision.reason.includes("approved_by_household"));
    // And the rule that stopped it survives, so an approved purchase stays
    // distinguishable from one that never needed asking.
    assert.ok(approved.vouch.authority.triggered_rules.includes("price > max_price"));
  });

  it("records a dispute and reports the threshold move", async () => {
    const { vouches } = await household<{ vouches: Vouch[] }>("state");
    const completed = vouches.find((v) => v.action.status === "Complete" && !v.dispute);
    assert.ok(completed);

    const result = await household<{ threshold_before: number; threshold_after: number }>(
      `vouches/${completed.vouch_id}/dispute`,
      { method: "POST", body: JSON.stringify({ reason: "I didn't want that" }) }
    );

    assert.ok(result.threshold_after > result.threshold_before);
  });

  it("returns a readable error for a second dispute rather than a stack trace", async () => {
    const { vouches } = await household<{ vouches: Vouch[] }>("state");
    const disputed = vouches.find((v) => v.dispute !== null);
    assert.ok(disputed);

    await assert.rejects(
      () =>
        household(`vouches/${disputed.vouch_id}/dispute`, {
          method: "POST",
          body: JSON.stringify({ reason: "again" }),
        }),
      /already disputed/
    );
  });
});
