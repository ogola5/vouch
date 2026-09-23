import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VouchStore } from "@vouch/db";
import { startMerchantServer } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { HttpMerchantClient, VouchService, startVouchHttpServer } from "@vouch/mcp-server";

/**
 * Everything in one piece, over two real network boundaries: an MCP client
 * speaking Streamable HTTP to Vouch's server, which speaks UCP over HTTP to
 * the merchant.
 *
 * The other test files deliberately call VouchService directly, because a
 * transport adds nothing to a question about the gate's logic. This file
 * exists for the parts those cannot reach — that the tools are actually
 * advertised, that HttpMerchantClient's headers satisfy a spec-conformant
 * merchant, and that a held purchase stays held when the refusal has to
 * survive two hops and a JSON-RPC round trip.
 *
 * It is also the closest thing in the repo to a rehearsal of the demo, so
 * the assertions follow the brief's section-8 running order.
 */

interface Rig {
  client: Client;
  merchantServer: Server;
  mcpServer: Server;
  store: VouchStore;
  merchantUrl: string;
  ring: MockRingProvider;
}

let rig: Rig;

/** Tool results come back as content blocks; every Vouch tool returns JSON text. */
async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content.map((block) => block.text).join("\n");
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return content.map((block) => block.text).join("\n");
}

before(async () => {
  const merchant = await startMerchantServer(0);
  const store = VouchStore.open(":memory:");
  const ring = new MockRingProvider();

  const service = new VouchService({
    store,
    merchant: new HttpMerchantClient(merchant.url),
    reasoning: new RuleBasedReasoningProvider(),
    physicalEvidence: ring,
  });

  const mcp = await startVouchHttpServer(0, { service });
  const client = new Client({ name: "vouch-e2e-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${mcp.url}/mcp`)));

  rig = {
    client,
    merchantServer: merchant.server,
    mcpServer: mcp.server,
    store,
    merchantUrl: merchant.url,
    ring,
  };
});

after(async () => {
  await rig.client.close();
  rig.mcpServer.close();
  rig.merchantServer.close();
  rig.store.close();
});

describe("the tool surface an orchestrator actually sees", () => {
  it("advertises the mandate, gate, dispute and query tools", async () => {
    const { tools } = await rig.client.listTools();
    const names = tools.map((t) => t.name).sort();

    assert.deepEqual(names, [
      "create_mandate",
      "explain_vouch",
      "get_mandate",
      "list_mandates",
      "list_vouches",
      "pause_mandate",
      "propose_purchase",
      "record_dispute",
      "search_catalog",
    ]);
  });

  it("offers the agent no way to widen its own authority", async () => {
    const { tools } = await rig.client.listTools();
    const names = tools.map((t) => t.name);

    // The rule this surface is built on: the agent may do anything that
    // cannot increase its own authority. Approving a held purchase turns a
    // refusal into an order; editing a mandate raises the ceiling the gate
    // checks against. Both are household-only, and their absence here is the
    // guarantee — a system prompt asking the model not to would only be a
    // request.
    assert.ok(!names.includes("approve_purchase"), "approval is the household's, not the agent's");
    assert.ok(!names.includes("update_mandate"), "an agent must not edit its own limits");
  });

  it("offers no tool that completes a checkout directly", async () => {
    const { tools } = await rig.client.listTools();

    // The structural version of "a real gate, not a caption": an agent
    // holding this toolset has no route to an order that skips the mandate.
    // If a complete_checkout-style tool ever appears here, the gate has
    // become bypassable and this test should fail loudly.
    for (const tool of tools) {
      assert.doesNotMatch(
        tool.name,
        /^(complete|create)_(checkout|cart|order)$/,
        `${tool.name} would let an agent reach an order without passing the mandate gate`
      );
    }
  });
});

describe("search_catalog — the tool the first live agent run proved was missing", () => {
  it("returns real, usable product ids", async () => {
    const products = await call<{ product_id: string; brand: string; price: number }[]>(
      rig.client,
      "search_catalog",
      {}
    );

    assert.equal(products.length, 3);
    // The exact id the model could not guess. It invented "brand-a-detergent";
    // nothing about the product's name suggests this ordering, which is the
    // point — ids are not derivable and must be looked up.
    assert.ok(products.some((p) => p.product_id === "detergent-brand-a"));
  });

  it("reports prices in dollars, so they compare directly against a mandate", async () => {
    const products = await call<{ product_id: string; price: number; currency: string }[]>(
      rig.client,
      "search_catalog",
      { query: "brand-c" }
    );

    assert.equal(products.length, 1);
    // 27.80, not 2780. A model shown minor units beside a mandate saying
    // max_price 15 would conclude every item is wildly over budget.
    assert.equal(products[0]?.price, 27.8);
    assert.equal(products[0]?.currency, "USD");
  });

  it("filters on id, title and brand", async () => {
    const byBrand = await call<unknown[]>(rig.client, "search_catalog", { query: "Brand A" });
    assert.equal(byBrand.length, 1);

    const byNothing = await call<unknown[]>(rig.client, "search_catalog", { query: "zzz" });
    assert.equal(byNothing.length, 0, "an empty result is better than a guess");
  });

  it("is read-only — listing cannot move a price or place an order", async () => {
    const before = await call<{ product_id: string; price: number }[]>(
      rig.client,
      "search_catalog",
      {}
    );
    const vouchesBefore = await call<unknown[]>(rig.client, "list_vouches", {});

    await call<unknown[]>(rig.client, "search_catalog", { query: "detergent" });

    const after = await call<{ product_id: string; price: number }[]>(
      rig.client,
      "search_catalog",
      {}
    );
    const vouchesAfter = await call<unknown[]>(rig.client, "list_vouches", {});

    assert.deepEqual(after, before);
    assert.equal(vouchesAfter.length, vouchesBefore.length);
  });
});

describe("the demo script, over the wire", () => {
  it("1. sets a mandate from a plain-language instruction", async () => {
    const mandate = await call<{ mandate_id: string; confidence_threshold: number }>(
      rig.client,
      "create_mandate",
      {
        mandate_id: "m_detergent",
        goal: "Keep laundry detergent stocked",
        constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
        requires_approval_if: ["price > max_price", "new_brand"],
        authority_type: "explicit",
        confidence_threshold: 0.85,
      }
    );

    assert.equal(mandate.mandate_id, "m_detergent");
    assert.equal(mandate.confidence_threshold, 0.85);
  });

  it("2. a price drop leads to a purchase within bounds, corroborated by Ring", async () => {
    // The world changes: Brand A drops. This goes through the merchant's
    // demo-control surface, so the agent observes a price it did not choose.
    const priceDrop = await fetch(`${rig.merchantUrl}/demo/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: "detergent-brand-a", price: 12.49 }),
    });
    assert.equal(priceDrop.status, 200);

    // Script the doorbell for this run so the demo shows a corroborated
    // Vouch at least once, per the brief's guardrail about showing both
    // states. MockRingProvider keys on order_id, which does not exist until
    // the order does, so the correlation is scripted by intercepting the
    // provider rather than pre-registering an id.
    const originalCorrelate = rig.ring.correlateDelivery.bind(rig.ring);
    rig.ring.correlateDelivery = async (request) => {
      rig.ring.scriptOutcome(request.order_id, "corroborated");
      return originalCorrelate(request);
    };

    const result = await call<{
      outcome: string;
      vouch: {
        vouch_id: string;
        decision: { price: number };
        evidence: {
          digital: { order_id: string };
          physical: { correlation_status: string };
        };
      };
    }>(rig.client, "propose_purchase", {
      mandate_id: "m_detergent",
      product_id: "detergent-brand-a",
      quantity: 2,
      brand: "Brand A",
      confidence: 0.92,
      reason: ["price_drop", "preferred_brand"],
    });

    rig.ring.correlateDelivery = originalCorrelate;

    assert.equal(result.outcome, "completed");
    assert.equal(result.vouch.decision.price, 12.49);
    assert.ok(result.vouch.evidence.digital.order_id);
    assert.equal(result.vouch.evidence.physical.correlation_status, "corroborated");
  });

  it("3. a $27.80 item is stopped by the gate, not bought and explained away", async () => {
    const result = await call<{
      outcome: string;
      session_status: string;
      vouch: { vouch_id: string; authority: { triggered_rules: string[] } };
    }>(rig.client, "propose_purchase", {
      mandate_id: "m_detergent",
      product_id: "detergent-brand-c",
      quantity: 1,
      brand: "Brand C",
      confidence: 0.95,
      reason: ["in_stock"],
    });

    assert.equal(result.outcome, "held_for_approval");
    assert.equal(result.session_status, "ready_for_complete");
    assert.ok(result.vouch.authority.triggered_rules.includes("price > max_price"));

    // 4. "why didn't you buy it?" — the answer names the actual boundary.
    const explanation = await callText(rig.client, "explain_vouch", {
      vouch_id: result.vouch.vouch_id,
    });
    assert.match(explanation, /stopped before buying/i);
    assert.match(explanation, /price > max_price/);
  });

  it("5. a dispute visibly tightens the mandate and changes the next decision", async () => {
    const vouches = await call<{ vouch_id: string; action: { status: string } }[]>(
      rig.client,
      "list_vouches",
      { mandate_id: "m_detergent" }
    );
    const completed = vouches.find((v) => v.action.status === "Complete");
    assert.ok(completed, "there should be a completed purchase to dispute");

    const dispute = await call<{ threshold_before: number; threshold_after: number }>(
      rig.client,
      "record_dispute",
      { vouch_id: completed.vouch_id, reason: "I didn't want that" }
    );

    assert.equal(dispute.threshold_before, 0.85);
    assert.equal(dispute.threshold_after, 0.88);

    // A proposal that would have passed at 0.85 is now held at 0.88.
    const afterDispute = await call<{ outcome: string; vouch: { authority: { triggered_rules: string[] } } }>(
      rig.client,
      "propose_purchase",
      {
        mandate_id: "m_detergent",
        product_id: "detergent-brand-a",
        quantity: 1,
        brand: "Brand A",
        // Between the household's baseline (0.85) and the post-dispute
        // threshold (0.88). A confidence equal to the threshold passes, so
        // this has to sit strictly inside the gap the dispute opened.
        confidence: 0.86,
        reason: ["restock"],
      }
    );

    assert.equal(afterDispute.outcome, "held_for_approval");
    assert.deepEqual(afterDispute.vouch.authority.triggered_rules, ["below_confidence_threshold"]);
  });

  it("6. the household record shows completed, pending and disputed side by side", async () => {
    const vouches = await call<
      {
        action: { status: string };
        dispute: { reason: string } | null;
        evidence: { physical: { correlation_status: string } };
      }[]
    >(rig.client, "list_vouches", { mandate_id: "m_detergent" });

    const statuses = vouches.map((v) => v.action.status);
    assert.ok(statuses.includes("Complete"));
    assert.ok(statuses.includes("PendingApproval"));
    assert.equal(vouches.filter((v) => v.dispute !== null).length, 1);

    // The guardrail, visible in the record: both correlation states appear,
    // and neither is ever a boolean "delivered".
    const correlations = new Set(vouches.map((v) => v.evidence.physical.correlation_status));
    assert.ok(correlations.has("corroborated"));
    assert.ok(correlations.has("not_applicable"));
    for (const status of correlations) {
      assert.ok(
        ["corroborated", "unconfirmed", "not_applicable"].includes(status),
        `"${status}" is not one of the three honest correlation states`
      );
    }
  });
});

describe("errors survive the transport instead of looking like success", () => {
  it("reports a missing mandate as a tool error", async () => {
    const result = await rig.client.callTool({
      name: "propose_purchase",
      arguments: {
        mandate_id: "does_not_exist",
        product_id: "detergent-brand-a",
        quantity: 1,
        brand: "Brand A",
        confidence: 0.9,
        reason: [],
      },
    });

    assert.equal(result.isError, true);
    const content = result.content as { text: string }[];
    assert.match(content[0]!.text, /No mandate with id/);
  });
});
