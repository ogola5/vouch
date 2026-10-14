import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { VouchStore } from "@vouch/db";
import { startMerchantServer } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { HttpMerchantClient, VouchService, WAITING_URI, startVouchHttpServer } from "@vouch/mcp-server";

/**
 * T4: the record as MCP resources, and a client told — without asking — when
 * the gate holds a purchase. The Alexa+ moment: one client (a device) is
 * subscribed; another (an agent) asks for something over the limit; the
 * device hears about it.
 */

let servers: Server[] = [];
let store: VouchStore;
let url: string;
const clients: Client[] = [];

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(client);
  return client;
}

before(async () => {
  const merchant = await startMerchantServer(0);
  store = VouchStore.open(":memory:");
  const service = new VouchService({
    store,
    merchant: new HttpMerchantClient(merchant.url),
    reasoning: new RuleBasedReasoningProvider(),
    physicalEvidence: new MockRingProvider(),
  });
  service.createMandate({
    mandate_id: "m_detergent",
    goal: "Keep laundry detergent stocked",
    constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
    requires_approval_if: ["price > max_price", "new_brand"],
    authority_type: "explicit",
    confidence_threshold: 0.85,
  });
  const started = await startVouchHttpServer(0, { service });
  servers = [merchant.server, started.server, started.householdServer];
  url = `${started.url}/mcp`;
});

after(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  servers.forEach((s) => s.close());
  store.close();
});

describe("the record as MCP resources (T4)", () => {
  it("tells a subscribed client the moment the gate holds a purchase someone else asked for", async () => {
    const device = await connect("device");
    const updates: string[] = [];
    device.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => { updates.push(n.params.uri); });
    await device.subscribeResource({ uri: WAITING_URI });

    const agent = await connect("agent");
    const proposed = await agent.callTool({
      name: "propose_purchase",
      arguments: { mandate_id: "m_detergent", product_id: "detergent-brand-c", quantity: 1, brand: "Brand C", confidence: 0.9, reason: ["probe"] },
    });
    const held = proposed.structuredContent as { outcome: string; vouch: { vouch_id: string } };
    assert.equal(held.outcome, "held_for_approval");

    // The device was told, without asking.
    for (let i = 0; i < 50 && !updates.includes(WAITING_URI); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(updates.includes(WAITING_URI), `no update; got ${JSON.stringify(updates)}`);

    // And reading the resource shows what is waiting.
    const waiting = await device.readResource({ uri: WAITING_URI });
    const list = JSON.parse((waiting.contents[0] as { text: string }).text) as { vouch_id: string }[];
    assert.ok(list.some((v) => v.vouch_id === held.vouch.vouch_id));

    // The agent, which did not subscribe, was not sent anything about it.
    const record = await agent.readResource({ uri: `vouch://records/${held.vouch.vouch_id}` });
    assert.match((record.contents[0] as { text: string }).text, /PendingApproval/);
  });

  it("lists mandates as resources, and reads one", async () => {
    const client = await connect("reader");
    const listed = await client.listResources();
    assert.ok(listed.resources.some((r) => r.uri === "vouch://mandates/m_detergent"));
    assert.ok(listed.resources.some((r) => r.uri === WAITING_URI));
    const m = await client.readResource({ uri: "vouch://mandates/m_detergent" });
    assert.match((m.contents[0] as { text: string }).text, /"confidence_threshold": 0.85/);
    const templates = await client.listResourceTemplates();
    assert.ok(templates.resourceTemplates.some((t) => t.uriTemplate === "vouch://records/{vouch_id}"));
  });

  it("serves a mandate as an AP2 Intent Mandate, read-only (Q1)", async () => {
    const client = await connect("ap2-reader");
    const r = await client.readResource({ uri: "vouch://ap2/intent-mandates/m_detergent" });
    const x = JSON.parse((r.contents[0] as { text: string }).text) as {
      intent_mandate: { natural_language_description: string; user_cart_confirmation_required: boolean };
      vouch_extension: { max_price: number };
    };
    assert.match(x.intent_mandate.natural_language_description, /at most \$15\.00/);
    assert.equal(x.intent_mandate.user_cart_confirmation_required, true);
    assert.equal(x.vouch_extension.max_price, 15);
    // A resource, not a tool: the agent's tool surface is unchanged.
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => /ap2/i.test(t.name)));
  });

  it("refuses a request without a session, and a session that does not exist", async () => {
    const noSession = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(noSession.status, 400);
    const unknown = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": "not-a-session" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unknown.status, 404);
  });
});
