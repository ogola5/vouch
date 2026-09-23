import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";

import { VouchStore } from "@vouch/db";
import { startMerchantServer } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { HttpMerchantClient, VouchService, startVouchHttpServer } from "@vouch/mcp-server";
import { connectVouchToolset, diffToolNames, EXPECTED_VOUCH_TOOLS } from "@vouch/orchestrator";

/**
 * Step one of the orchestrator, and deliberately model-free.
 *
 * The question this file answers is narrow: does the Strands SDK actually
 * reach our MCP server and drive our tools? That is worth isolating, because
 * once a model is in the loop every failure looks the same from the outside —
 * "the agent didn't buy it" could be a broken transport, a renamed tool, or
 * the model simply choosing not to. Here there is no model, so a failure has
 * exactly one possible cause.
 */

let toolset: Awaited<ReturnType<typeof connectVouchToolset>>;
let mcp: Server;
let household: Server;
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
  household = started.householdServer;

  toolset = await connectVouchToolset({ url: `${started.url}/mcp` });
});

after(async () => {
  await toolset.disconnect();
  // Second listener: leaving it open keeps the event loop alive.
  household.close();
  mcp.close();
  merchantServer.close();
  store.close();
});

describe("Strands reaches the Vouch MCP server", () => {
  it("connects over Streamable HTTP built from a url alone", () => {
    // BUILD_PLAN.md §3 assumed a hand-built StreamableHTTPClientTransport was
    // needed here. It is not — McpClient constructs one from `url`. This
    // assertion is what retires that note.
    assert.equal(toolset.client.connectionState, "connected");
  });

  it("advertises exactly the nine Vouch tools, under the names we expect", () => {
    assert.deepEqual(toolset.toolNames, [...EXPECTED_VOUCH_TOOLS]);

    const { missing, unexpected } = diffToolNames(toolset.toolNames);
    assert.deepEqual(missing, [], "a missing tool leaves the agent unable to act");
    assert.deepEqual(unexpected, [], "an unexpected tool means this list is stale");
  });

  it("picks up the server's instructions, which is how the agent learns the rules", () => {
    // packages/mcp-server sets instructions telling a client that every
    // purchase goes through propose_purchase and that a held result must not
    // be worked around. If those stop arriving, the model loses the only
    // in-band statement of how Vouch expects to be used.
    const instructions = toolset.client.serverInstructions ?? "";
    assert.match(instructions, /propose_purchase/);
    assert.match(instructions, /held_for_approval/);
  });
});

describe("Strands can drive the tools, not just list them", () => {
  it("creates a mandate through the SDK", async () => {
    const tools = await toolset.client.listTools();
    const create = tools.find((t) => t.name === "create_mandate");
    assert.ok(create);

    await toolset.client.callTool(create, {
      mandate_id: "m_detergent",
      goal: "Keep laundry detergent stocked",
      constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
      requires_approval_if: ["price > max_price", "new_brand"],
      authority_type: "explicit",
      confidence_threshold: 0.85,
    });

    const list = tools.find((t) => t.name === "list_mandates");
    assert.ok(list);
    const result = JSON.stringify(await toolset.client.callTool(list, {}));
    assert.match(result, /m_detergent/);
  });

  it("hits the real gate — an out-of-bounds purchase comes back held", async () => {
    const tools = await toolset.client.listTools();
    const propose = tools.find((t) => t.name === "propose_purchase");
    assert.ok(propose);

    // Brand C is $27.80 against a $15 mandate.
    const raw = await toolset.client.callTool(propose, {
      mandate_id: "m_detergent",
      product_id: "detergent-brand-c",
      quantity: 1,
      brand: "Brand C",
      confidence: 0.95,
      reason: ["in_stock"],
    });

    // The gate's verdict has to survive the SDK's own result wrapping, which
    // is the whole reason this assertion is here rather than in mcp-server's
    // tests: a client that quietly swallowed or reshaped the refusal would
    // let an agent proceed as though the purchase had gone through.
    const text = JSON.stringify(raw);
    assert.match(text, /held_for_approval/);
    assert.match(text, /price > max_price/);
    assert.match(text, /ready_for_complete/);
    assert.doesNotMatch(text, /"status":\s*"Complete"/);
  });
});
