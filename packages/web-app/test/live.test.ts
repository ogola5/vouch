import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VouchStore } from "@vouch/db";
import { startMerchantServer } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { HttpMerchantClient, VouchService, startVouchHttpServer } from "@vouch/mcp-server";
import { VouchBridge, startWebApp } from "@vouch/web-app";

/**
 * T4's two consequences for the console:
 *  - sessions must not cost resilience: when the MCP server restarts, the
 *    console starts a new session by itself (stateless mode never needed to);
 *  - a purchase the console did not start reaches the page by itself.
 */

const toClose: { close: () => unknown }[] = [];
after(async () => {
  for (const c of toClose.reverse()) await c.close();
});

async function stack(store: VouchStore, merchantUrl: string, port = 0) {
  const service = new VouchService({
    store,
    merchant: new HttpMerchantClient(merchantUrl),
    reasoning: new RuleBasedReasoningProvider(),
    physicalEvidence: new MockRingProvider(),
  });
  return startVouchHttpServer(port, { service });
}

function stop(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("the console, live (T4)", () => {
  it("starts a new session by itself when the MCP server restarts", async () => {
    const merchant = await startMerchantServer(0);
    const store = VouchStore.open(":memory:");
    toClose.push(merchant.server, store);

    const first = await stack(store, merchant.url);
    const port = (first.server.address() as AddressInfo).port;
    const bridge = new VouchBridge(`${first.url}/mcp`);
    assert.ok((await bridge.listToolNames()).includes("propose_purchase"));

    // Restart the MCP server on the same port: every session is gone.
    await stop(first.server);
    first.householdServer.close();
    const second = await stack(store, merchant.url, port);
    toClose.push(second.server, second.householdServer);

    // The bridge's next call meets "Session not found", starts a new session, and succeeds.
    assert.ok((await bridge.listToolNames()).includes("propose_purchase"));
    await bridge.close();
  });

  it("opens one session when several requests connect at once", async () => {
    // The page's first data request and its event stream arrive together.
    const merchant = await startMerchantServer(0);
    const store = VouchStore.open(":memory:");
    const mcp = await stack(store, merchant.url);
    toClose.push(merchant.server, store, mcp.server, mcp.householdServer);
    const bridge = new VouchBridge(`${mcp.url}/mcp`);
    await Promise.all([bridge.connect(), bridge.connect(), bridge.connect()]);
    const names = await Promise.all([bridge.listToolNames(), bridge.listToolNames()]);
    assert.ok(names.every((n) => n.includes("propose_purchase")));
    await bridge.close();
  });

  it("streams a change to the page when an outside client's purchase is held", async () => {
    const merchant = await startMerchantServer(0);
    const store = VouchStore.open(":memory:");
    const mcp = await stack(store, merchant.url);
    const web = await startWebApp(0, { mcpUrl: `${mcp.url}/mcp`, merchantUrl: merchant.url, householdUrl: mcp.householdUrl });
    toClose.push(merchant.server, store, mcp.server, mcp.householdServer, web.server, { close: () => web.bridge.close() });

    const outside = new Client({ name: "outside-agent", version: "1.0.0" });
    await outside.connect(new StreamableHTTPClientTransport(new URL(`${mcp.url}/mcp`)));
    toClose.push(outside);
    await outside.callTool({
      name: "create_mandate",
      arguments: {
        mandate_id: "m_live", goal: "Keep detergent stocked",
        constraints: { max_price: 15, preferred_brand: "Brand A" },
        requires_approval_if: ["price > max_price", "new_brand"], authority_type: "explicit",
      },
    });

    const controller = new AbortController();
    const res = await fetch(`${web.url}/api/events`, { signal: controller.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    let seen = "";
    const heard = (async () => {
      const decoder = new TextDecoder();
      while (!seen.includes("event: record")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value);
      }
    })();
    await new Promise((r) => setTimeout(r, 100)); // the stream is open and the bridge subscribed

    await outside.callTool({
      name: "propose_purchase",
      arguments: { mandate_id: "m_live", product_id: "detergent-brand-c", quantity: 1, brand: "Brand C", confidence: 0.9, reason: ["test"] },
    });
    await Promise.race([heard, new Promise((r) => setTimeout(r, 3000))]);
    controller.abort();
    assert.match(seen, /event: record/, `the page was not told: ${JSON.stringify(seen)}`);
  });
});
