import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";

import { VouchStore } from "@vouch/db";
import { startMerchantServer } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { HouseholdAgent, HttpMerchantClient, VouchService, startVouchHttpServer } from "@vouch/mcp-server";
import { startWebApp } from "@vouch/web-app";

/**
 * The console is the first surface a human actually looks at, so the thing
 * worth testing is not that it renders — it is that it cannot LIE. Everything
 * the page shows has to come from the same MCP tools an agent calls, with no
 * second implementation in the bridge that could quietly disagree with the
 * server.
 *
 * Concretely, the test that matters here is the last one: a held purchase
 * must still read as held through three hops (browser -> web-app -> MCP ->
 * merchant). A dashboard that showed "bought" for a purchase the gate
 * refused would be worse than no dashboard at all.
 */

// Inferred from startWebApp rather than hand-written, so the annotation
// cannot drift behind what the function actually returns.
let web: Awaited<ReturnType<typeof startWebApp>>;
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

  const householdAgent = new HouseholdAgent({ store, service });
  const mcpStarted = await startVouchHttpServer(0, { service, householdAgent });
  mcp = mcpStarted.server;
  household = mcpStarted.householdServer;

  web = await startWebApp(0, {
    mcpUrl: `${mcpStarted.url}/mcp`,
    merchantUrl: merchant.url,
    householdUrl: mcpStarted.householdUrl,
  });
});

after(async () => {
  // The bridge holds a live MCP client, and closing only the HTTP servers
  // leaves its transport open — the suite then passes but the process never
  // exits, which in CI reads as a hang rather than as a leak. Close it first.
  await web.bridge.close();
  web.server.close();
  household.close();
  mcp.close();
  merchantServer.close();
  store.close();
});

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${web.url}${path}`);
  assert.ok(response.ok, `GET ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${web.url}/api/tool/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = (await response.json()) as { ok: boolean; text: string };
  if (!body.ok) throw new Error(body.text);
  return JSON.parse(body.text) as T;
}

describe("the console serves a page and reaches the MCP server", () => {
  it("serves the dashboard HTML", async () => {
    const response = await fetch(`${web.url}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /Vouch Console/);
  });

  it("reports the live tool list through the bridge", async () => {
    const health = await get<{ ok: boolean; tools: string[] }>("/api/health");
    assert.equal(health.ok, true);
    assert.ok(health.tools.includes("propose_purchase"));
    assert.ok(health.tools.includes("record_dispute"));
  });

  it("aggregates mandates, vouches and the catalogue in one call", async () => {
    const state = await get<{ mandates: unknown[]; vouches: unknown[]; catalog: unknown[] }>(
      "/api/state"
    );
    assert.deepEqual(state.mandates, []);
    assert.deepEqual(state.vouches, []);
    // 3 detergents + a preferred and fallback product for 5 more household items.
    assert.equal(state.catalog.length, 13, "the demo catalogue should be visible to the page");
  });
});

describe("the demo levers work from the browser's side", () => {
  it("creates a mandate and shows it in state", async () => {
    await tool("create_mandate", {
      mandate_id: "m_detergent",
      goal: "Keep laundry detergent stocked",
      constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
      requires_approval_if: ["price > max_price", "new_brand"],
      authority_type: "explicit",
      confidence_threshold: 0.85,
    });

    const state = await get<{ mandates: { mandate_id: string }[] }>("/api/state");
    assert.equal(state.mandates.length, 1);
    assert.equal(state.mandates[0]?.mandate_id, "m_detergent");
  });

  it("changes a price through /api/price and the catalogue reflects it", async () => {
    const response = await fetch(`${web.url}/api/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: "detergent-brand-a", price: 12.49 }),
    });
    assert.equal(response.status, 200);

    const state = await get<{ catalog: { id: string; price: number }[] }>("/api/state");
    const brandA = state.catalog.find((p) => p.id === "detergent-brand-a");
    assert.equal(brandA?.price, 1249, "catalogue prices stay in minor units on the wire");
  });

  it("rejects a malformed price change rather than guessing", async () => {
    const response = await fetch(`${web.url}/api/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: "detergent-brand-a" }),
    });
    assert.equal(response.status, 400);
  });
});

describe("chat degrades without taking the console with it", () => {
  // These run with no model key in the test environment, which is the
  // case that matters: the console is the household's evidence surface, and
  // evidence that vanishes when an unrelated API key expires is not evidence.
  const configured = Boolean(
    process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() || process.env.GEMINI_API_KEY?.trim()
  );

  it("reports chat status alongside the tool list", async () => {
    const health = await get<{ chat: { status: string; detail: string } }>("/api/health");
    assert.ok(["ready", "unconfigured", "failed"].includes(health.chat.status));
    if (!configured) {
      assert.equal(health.chat.status, "unconfigured");
      assert.match(health.chat.detail, /still works/i);
    }
  });

  it("refuses an empty message before spending a model call", async () => {
    const response = await fetch(`${web.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    assert.equal(response.status, 400);
  });

  it("answers an unconfigured model with 503, not 500", async () => {
    if (configured) return; // nothing to assert when a key is present
    const response = await fetch(`${web.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    // 503 rather than 500 because nothing is broken — the gate, the record and
    // every control still work. The page says which part is unavailable.
    assert.equal(response.status, 503);
  });

  it("leaves the gate and the record fully working with no model at all", async () => {
    // The claim the lazy agent exists to protect, asserted rather than assumed.
    const state = await get<{ catalog: unknown[] }>("/api/state");
    assert.equal(state.catalog.length, 13);

    const result = await tool<{ outcome: string }>("propose_purchase", {
      mandate_id: "m_detergent",
      product_id: "detergent-brand-c",
      quantity: 1,
      brand: "Brand C",
      confidence: 0.95,
      reason: ["no_model_needed"],
    });
    assert.equal(result.outcome, "held_for_approval");
  });
});

describe("the console cannot misreport the gate", () => {
  it("shows a completed purchase as complete", async () => {
    const result = await tool<{ outcome: string }>("propose_purchase", {
      mandate_id: "m_detergent",
      product_id: "detergent-brand-a",
      quantity: 1,
      brand: "Brand A",
      confidence: 0.92,
      reason: ["price_drop"],
    });
    assert.equal(result.outcome, "completed");

    const state = await get<{ vouches: { action: { status: string } }[] }>("/api/state");
    assert.equal(state.vouches[0]?.action.status, "Complete");
  });

  it("shows a held purchase as held, with the rule that stopped it and no order", async () => {
    const result = await tool<{ outcome: string; session_status: string }>("propose_purchase", {
      mandate_id: "m_detergent",
      product_id: "detergent-brand-c", // $27.80 against a $15 mandate
      quantity: 1,
      brand: "Brand C",
      confidence: 0.95,
      reason: ["in_stock"],
    });

    assert.equal(result.outcome, "held_for_approval");
    assert.equal(result.session_status, "ready_for_complete");

    const state = await get<{
      vouches: {
        action: { status: string };
        authority: { triggered_rules: string[] };
        evidence: { digital: { order_id: string | null } };
      }[];
    }>("/api/state");

    const held = state.vouches.find((v) => v.action.status === "PendingApproval");
    assert.ok(held, "the held purchase must be visible in the record, not hidden");
    assert.ok(held.authority.triggered_rules.includes("price > max_price"));
    assert.equal(held.evidence.digital.order_id, null, "a held purchase must show no order id");
  });

  it("surfaces a tool error as an error instead of an empty table", async () => {
    const response = await fetch(`${web.url}/api/tool/propose_purchase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mandate_id: "nope",
        product_id: "detergent-brand-a",
        quantity: 1,
        brand: "Brand A",
        confidence: 0.9,
        reason: [],
      }),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { ok: boolean; text: string };
    assert.equal(body.ok, false);
    assert.match(body.text, /No mandate with id/);
  });

  it("moves the threshold on the page's own dispute path", async () => {
    const state = await get<{ vouches: { vouch_id: string; action: { status: string } }[] }>(
      "/api/state"
    );
    const completed = state.vouches.find((v) => v.action.status === "Complete");
    assert.ok(completed);

    const dispute = await tool<{ threshold_before: number; threshold_after: number }>(
      "record_dispute",
      { vouch_id: completed.vouch_id, reason: "I didn't want that" }
    );

    assert.equal(dispute.threshold_before, 0.85);
    assert.equal(dispute.threshold_after, 0.88);

    const after = await get<{ mandates: { confidence_threshold: number }[] }>("/api/state");
    assert.equal(after.mandates[0]?.confidence_threshold, 0.88, "the page sees the new authority");
  });
});

describe("simulated failures leave the console standing", () => {
  const post = (path: string, body: unknown) =>
    fetch(`${web.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("with the store down, the record still loads and says so", async () => {
    await post("/api/demo/outage", { down: true });
    try {
      const state = await get<{ store_down: boolean; vouches: unknown[]; catalog: unknown[] }>("/api/state");
      assert.equal(state.store_down, true);
      assert.ok(Array.isArray(state.vouches), "the household's record must not disappear with the store");
      assert.equal((await get<{ store_down: boolean }>("/api/demo/status")).store_down, true);
    } finally {
      await post("/api/demo/outage", { down: false });
    }
    assert.equal((await get<{ store_down: boolean }>("/api/state")).store_down, false);
  });

  it("with the model down, the chat says so plainly while the gate still works", async () => {
    await post("/api/demo/model", { down: true });
    try {
      const status = (await get<{ chat: { status: string } }>("/api/health")).chat.status;
      if (status === "ready") {
        const r = await post("/api/chat", { message: "hello" });
        const body = (await r.json()) as { error: string };
        assert.match(body.error, /simulated outage/);
      }
      const state = await get<{ catalog: unknown[] }>("/api/state");
      assert.ok(state.catalog.length > 0, "the rest of the console carries on");
    } finally {
      await post("/api/demo/model", { down: false });
    }
  });
});

describe("the household panel reaches the household agent through the page", () => {
  // Last in the file on purpose: loading a household sets the system clock
  // to the household's, which the earlier tests do not expect.
  const post = async <T>(path: string, body: unknown = {}): Promise<T> => {
    const response = await fetch(`${web.url}/api/household/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.ok(response.ok, `POST ${path} -> ${response.status}`);
    return (await response.json()) as T;
  };

  it("starts empty, loads the demo household, and dates it", async () => {
    const empty = await get<{ set_up: boolean; items: unknown[] }>("/api/household/pantry");
    assert.equal(empty.set_up, false);
    assert.equal(empty.items.length, 0);

    const loaded = await post<{ set_up: boolean; date: string; items: { autonomy: { mode: string } }[] }>("demo/setup");
    assert.equal(loaded.set_up, true);
    assert.match(loaded.date, /^\d{4}-\d{2}-\d{2}$/, "the page needs a real date to say 'arrives Saturday'");
    assert.deepEqual(
      [...new Set(loaded.items.map((i) => i.autonomy.mode))].sort(),
      ["ask", "auto", "remind"],
      "the demo shows all three modes"
    );
  });

  it("moves the clock and reports what the agent did, in the same call", async () => {
    // A week, not three days: earlier tests in this file leave a HELD Brand C
    // purchase on the detergent mandate, and the agent rightly waits for the
    // household on that item — so it is toilet paper (Auto, weekends) that buys.
    const r = await post<{ actions: { kind: string; item_id: string }[] }>("clock/advance", { days: 7 });
    assert.ok(!r.actions.some((a) => a.item_id === "detergent" && a.kind === "proposed"), "detergent waits for the held purchase");
    assert.ok(r.actions.some((a) => a.kind === "proposed"), "an Auto item should have bought something");
    assert.ok(r.actions.some((a) => a.kind === "notified"), "Ask or Remind should have told the household");
  });
});
