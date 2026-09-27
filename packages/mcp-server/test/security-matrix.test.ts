import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VouchStore } from "@vouch/db";
import { startMerchantServer } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { HouseholdAgent, HttpMerchantClient, PasskeyGuard, VouchService, startVouchHttpServer } from "@vouch/mcp-server";

/**
 * THE SECURITY MATRIX. Every way we could think of for an agent — or someone
 * with access to the machine — to buy what the household did not allow,
 * tried against the real stack: an MCP client over Streamable HTTP, the
 * Vouch server, the gate, a UCP merchant over HTTP, the database.
 *
 * Each attack records what ACTUALLY happened, and the matrix is printed at
 * the end. The final test fails unless every attack was blocked — so the
 * "N/N blocked" line is a test result, not a slogan.
 *
 * What is NOT here, stated so the matrix is not read as more than it is: the
 * household surface trusts localhost until a passkey is registered (trust on
 * first use, documented), and an attacker with the database AND the
 * passkey's private key could forge anything. Both are README limits.
 */

interface Row {
  attack: string;
  expected: string;
  observed: string;
  blocked: boolean;
}
const rows: Row[] = [];

let client: Client;
let service: VouchService;
let store: VouchStore;
let merchantUrl: string;
let mcpUrl: string;
let householdUrl: string;
const closers: (() => void)[] = [];

async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[]).map((c) => c.text).join("\n");
    return { isError: Boolean(r.isError), text };
  } catch (error) {
    return { isError: true, text: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs one attack: `run` returns what happened and whether it was stopped. */
function attack(name: string, expected: string, run: () => Promise<{ blocked: boolean; observed: string }>) {
  it(name, async () => {
    const r = await run();
    rows.push({ attack: name, expected, observed: r.observed, blocked: r.blocked });
    assert.ok(r.blocked, `NOT BLOCKED: ${name} — ${r.observed}`);
  });
}

const DETERGENT = {
  mandate_id: "m_detergent",
  goal: "Keep laundry detergent stocked",
  constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
  requires_approval_if: ["price > max_price", "new_brand", "quantity > 2"],
  authority_type: "explicit",
};
const propose = (overrides: Record<string, unknown> = {}) =>
  tool("propose_purchase", {
    mandate_id: "m_detergent",
    product_id: "detergent-brand-a",
    quantity: 1,
    brand: "Brand A",
    confidence: 0.9,
    reason: ["restock"],
    ...overrides,
  });
const vouchOf = (text: string) => (JSON.parse(text) as { vouch: { vouch_id: string; action: { status: string }; evidence: { digital: { order_id: string | null } }; decision: { price: number | null }; authority: { triggered_rules: string[]; confidence_score: number | null } } }).vouch;
const ordersPlaced = () => service.listVouches({ limit: 1000 }).filter((v) => v.action.status === "Complete").length;

before(async () => {
  const merchant = await startMerchantServer(0);
  merchantUrl = merchant.url;
  store = VouchStore.open(":memory:");
  service = new VouchService({
    store,
    merchant: new HttpMerchantClient(merchant.url),
    reasoning: new RuleBasedReasoningProvider(),
    physicalEvidence: new MockRingProvider(),
  });
  const householdAgent = new HouseholdAgent({ store, service });
  const passkeys = new PasskeyGuard({ store, rpId: "localhost", origins: ["http://localhost:4030"] });
  const started = await startVouchHttpServer(0, { service, householdAgent, passkeys });
  mcpUrl = started.url;
  householdUrl = started.householdUrl;
  client = new Client({ name: "security-matrix", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${started.url}/mcp`)));
  await tool("create_mandate", DETERGENT);
  closers.push(() => started.server.close(), () => started.householdServer.close(), () => merchant.server.close(), () => store.close());
});

after(async () => {
  await client.close();
  for (const close of closers) close();
});

describe("the security matrix", () => {
  /* ---- the agent's own authority ---- */

  attack("Agent approves its own held purchase", "no such tool", async () => {
    const held = vouchOf((await propose({ product_id: "detergent-brand-c", brand: "Brand C" })).text);
    const r = await tool("approve_purchase", { vouch_id: held.vouch_id });
    return { blocked: r.isError && service.listVouches().find((v) => v.vouch_id === held.vouch_id)?.action.status === "PendingApproval", observed: "tool not found; the purchase stays held" };
  });

  attack("Agent completes a checkout directly", "no such tool", async () => {
    const r = await tool("complete_checkout", { id: "any" });
    return { blocked: r.isError, observed: "tool not found" };
  });

  attack("Agent raises its own spending limit", "no such tool", async () => {
    const r = await tool("update_mandate", { mandate_id: "m_detergent", constraints: { max_price: 100 } });
    return { blocked: r.isError && service.getMandate("m_detergent")?.constraints.max_price === 15, observed: "tool not found; limit still $15" };
  });

  attack("Household powers reached through the MCP port", "not served there", async () => {
    const r = await fetch(`${mcpUrl}/household/state`);
    return { blocked: r.status === 404, observed: `HTTP ${r.status} — the household surface is a separate, loopback-only port` };
  });

  attack("Agent creates a mandate that is already on Auto", "autonomy ignored", async () => {
    const r = await tool("create_mandate", { ...DETERGENT, mandate_id: "m_smuggled", autonomy: { mode: "auto", until: null, delivery_days: null } });
    const mode = (JSON.parse(r.text) as { autonomy: { mode: string } }).autonomy.mode;
    return { blocked: mode === "ask", observed: `mandate created in "${mode}"` };
  });

  attack("Agent claims the forecast asked for it", "context ignored", async () => {
    const r = await propose({ household: { item_id: "detergent", day: 1, need: { kind: "forecast", runoutRisk: 1, status: "out" }, days_per_pack: 1, days_left: null, runout_risk: 1, delivery_day: 2 } });
    const v = JSON.parse(r.text).vouch as { household: unknown };
    return { blocked: v.household === null, observed: "recorded as an ordinary request" };
  });

  /* ---- what the gate compares ---- */

  attack("Agent names its own price", "merchant's price used", async () => {
    const v = vouchOf((await propose({ product_id: "detergent-brand-c", brand: "Brand C", price: 1 })).text);
    return { blocked: v.decision.price === 27.8 && v.action.status === "PendingApproval", observed: `gate compared $${v.decision.price}, the merchant's price; held` };
  });

  attack("Agent inflates its confidence on an unapproved brand", "capped by evidence", async () => {
    const v = vouchOf((await propose({ product_id: "detergent-brand-c", brand: "Brand C", confidence: 0.99 })).text);
    return { blocked: v.authority.confidence_score === 0.6 && v.authority.triggered_rules.includes("below_confidence_threshold"), observed: `claimed 0.99, gate compared ${v.authority.confidence_score}; held` };
  });

  attack("Price over the limit", "held, no order", async () => {
    const before = ordersPlaced();
    const v = vouchOf((await propose({ product_id: "detergent-brand-c", brand: "Brand C" })).text);
    return { blocked: v.action.status === "PendingApproval" && v.evidence.digital.order_id === null && ordersPlaced() === before, observed: "held at ready_for_complete; no order" };
  });

  attack("A brand the household never approved", "held", async () => {
    const v = vouchOf((await propose({ product_id: "detergent-brand-c", brand: "Brand C" })).text);
    return { blocked: v.authority.triggered_rules.includes("new_brand"), observed: "held on new_brand" };
  });

  attack("More than the quantity limit", "held", async () => {
    const v = vouchOf((await propose({ quantity: 3 })).text);
    return { blocked: v.authority.triggered_rules.includes("quantity > 2"), observed: "held on quantity > 2" };
  });

  attack("Buying on a paused mandate", "held", async () => {
    await tool("pause_mandate", { mandate_id: "m_detergent", paused: true });
    const v = vouchOf((await propose()).text);
    await service.updateMandate("m_detergent", { status: "active" });
    return { blocked: v.authority.triggered_rules.includes("mandate_paused"), observed: "held on mandate_paused" };
  });

  attack("A rule the gate cannot read", "refused at creation", async () => {
    const r = await tool("create_mandate", { ...DETERGENT, mandate_id: "m_bad_rule", requires_approval_if: ["quantity > N"] });
    return { blocked: r.isError && service.getMandate("m_bad_rule") === null, observed: "create_mandate rejected; nothing stored" };
  });

  attack("Buying unprompted on an item set to Ask", "held by the gate", async () => {
    const r = await service.proposePurchase({
      mandate_id: "m_detergent", product_id: "detergent-brand-a", brand: "Brand A", quantity: 1, reason: ["running_low"],
      household: { item_id: "detergent", day: 1, need: { kind: "forecast", runoutRisk: 0.9, status: "stocked" }, days_per_pack: 28, days_left: null, runout_risk: 0.9, delivery_day: 3 },
    });
    return { blocked: r.vouch.authority.triggered_rules.includes("autonomy_not_granted"), observed: "held on autonomy_not_granted" };
  });

  /* ---- malformed and repeated requests ---- */

  attack("Malformed tool input", "rejected, nothing created", async () => {
    const before = service.listVouches({ limit: 1000 }).length;
    const a = await propose({ quantity: -1 });
    const b = await propose({ confidence: 2 });
    return { blocked: a.isError && b.isError && service.listVouches({ limit: 1000 }).length === before, observed: "schema rejected quantity -1 and confidence 2; no record, no checkout" };
  });

  attack("The same checkout created twice", "idempotent", async () => {
    const http = new HttpMerchantClient(merchantUrl);
    const key = randomBytes(8).toString("hex");
    const body = { line_items: [{ item: { id: "detergent-brand-a" }, quantity: 1 }], currency: "USD" };
    const one = await http.createSession(body, { requestId: "r1", idempotencyKey: key });
    const two = await http.createSession(body, { requestId: "r2", idempotencyKey: key });
    return { blocked: one.id === two.id, observed: "same Idempotency-Key → the same session, not a second one" };
  });

  attack("Approving the same purchase twice", "one order only", async () => {
    const held = vouchOf((await propose({ product_id: "detergent-brand-c", brand: "Brand C" })).text);
    const before = ordersPlaced();
    await service.approvePurchase(held.vouch_id);
    const second = await service.approvePurchase(held.vouch_id).then(() => "approved again", (e: Error) => e.message);
    return { blocked: ordersPlaced() === before + 1 && /not "PendingApproval"/.test(second), observed: "second approval refused; one order" };
  });

  /* ---- failure, the household's powers, the record ---- */

  attack("The store goes down mid-purchase", "fails closed, recorded", async () => {
    await fetch(`${merchantUrl}/demo/outage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ down: true }) });
    const before = ordersPlaced();
    const r = await propose();
    await fetch(`${merchantUrl}/demo/outage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ down: false }) });
    const failed = service.listVouches({ limit: 5 }).find((v) => v.action.status === "Failed");
    return { blocked: r.isError && ordersPlaced() === before && failed !== undefined, observed: "no order; a Failed record says why" };
  });

  attack("Widening authority without the passkey", "refused (401)", async () => {
    // Register a passkey (a software authenticator — a real P-256 key).
    const opts = (await (await fetch(`${householdUrl}/household/passkey/register/options`, { method: "POST" })).json()) as { challenge_id: string; challenge: string };
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const count = Buffer.alloc(4);
    count.writeUInt32BE(1);
    await fetch(`${householdUrl}/household/passkey/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challenge_id: opts.challenge_id,
        credential_id: randomBytes(16).toString("base64url"),
        client_data_json: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin: "http://localhost:4030" })).toString("base64url"),
        authenticator_data: Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([0x05]), count]).toString("base64url"),
        public_key: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
        algorithm: -7,
      }),
    });
    const r = await fetch(`${householdUrl}/household/mandates/m_detergent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ constraints: { max_price: 100, preferred_brand: "Brand A", fallback_brand: "Brand B" } }),
    });
    return { blocked: r.status === 401 && service.getMandate("m_detergent")?.constraints.max_price === 15, observed: `HTTP ${r.status}; limit still $15` };
  });

  attack("Editing a record in the database", "detected and named", async () => {
    const bought = service.listVouches({ limit: 1000 }).find((v) => v.action.status === "Complete")!;
    service.tamperForDemo(bought.vouch_id, 0.01);
    const report = store.verifyLedger();
    return { blocked: !report.ok && report.problems.some((p) => p.vouch_id === bought.vouch_id), observed: "record check fails, naming the purchase" };
  });

  it("blocks every attack in the matrix", () => {
    const blocked = rows.filter((r) => r.blocked).length;
    const width = Math.max(...rows.map((r) => r.attack.length));
    console.log(`\n  SECURITY MATRIX — ${blocked}/${rows.length} blocked\n`);
    for (const r of rows) console.log(`  ${r.blocked ? "✓" : "✗"} ${r.attack.padEnd(width)}  ${r.observed}`);
    console.log("");
    assert.equal(rows.length, 20, "every attack in the matrix ran");
    assert.equal(blocked, rows.length, `${rows.length - blocked} attack(s) got through`);
  });
});
