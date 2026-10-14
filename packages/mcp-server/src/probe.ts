import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * An outside MCP client, connecting cold (BUILD_PLAN.md S3).
 *
 * The console, the Strands agent and the tests all reach Vouch through code
 * in this repo. This proves the integration does not depend on any of them:
 * a client that knows nothing but the URL discovers the tools, is told the
 * rules in the server's own instructions, meets the same gate, and finds no
 * way around it. That is the position Alexa+ would be in once add-on access
 * opens — it is the claim "pluggable", made checkable.
 *
 * Side effects, stated: it creates (once) a mandate "m_probe" and leaves one
 * held, never-completed checkout on the record each run. Nothing is bought.
 */

export interface ProbeStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface ProbeReport {
  url: string;
  server: string;
  tools: string[];
  steps: ProbeStep[];
  passed: boolean;
}

const PROBE_MANDATE = "m_probe";

function textOf(result: unknown): string {
  const content = ((result as { content?: { text?: string }[] }).content ?? []) as { text?: string }[];
  return content.map((c) => c.text ?? "").join("\n");
}

export async function probeMcp(url: string): Promise<ProbeReport> {
  const client = new Client({ name: "vouch-outside-probe", version: "1.0.0" });
  const steps: ProbeStep[] = [];
  const add = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail });

  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const info = client.getServerVersion();
    const instructions = client.getInstructions() ?? "";
    add("connect cold, with nothing but the URL", true, `${info?.name ?? "?"} ${info?.version ?? ""}`.trim());
    add(
      "the server states its own rules",
      /propose_purchase/.test(instructions) && /held_for_approval/.test(instructions),
      instructions.slice(0, 160)
    );

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const widening = tools.filter((n) => /approve|complete|checkout|raise|limit|edit|update_mandate/.test(n));
    add("discover the tools", tools.includes("propose_purchase"), tools.join(", "));
    add("no tool can widen the agent's own authority", widening.length === 0, widening.length ? `found: ${widening.join(", ")}` : "none to approve, complete a checkout or raise a limit");

    // Typed results (T3): read structuredContent, which the client has
    // already validated against the tool's declared outputSchema.
    const listed = await client.callTool({ name: "list_mandates", arguments: {} });
    const mandates = (listed.structuredContent as { mandates: { mandate_id: string }[] }).mandates;
    const typed = (await client.listTools()).tools.filter((t) => t.outputSchema).map((t) => t.name);
    add("typed results, declared up front", typed.includes("propose_purchase"), `outputSchema on: ${typed.join(", ")}`);
    if (!mandates.some((m) => m.mandate_id === PROBE_MANDATE)) {
      const created = await client.callTool({
        name: "create_mandate",
        arguments: {
          mandate_id: PROBE_MANDATE,
          goal: "Probe: an outside MCP client checking the gate",
          constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
          requires_approval_if: ["price > max_price", "new_brand"],
          authority_type: "explicit",
        },
      });
      add("set a mandate: under $15, Brand A or B", !created.isError, created.isError ? textOf(created) : "m_probe");
    } else {
      add("set a mandate: under $15, Brand A or B", true, "m_probe already exists");
    }

    // T4: subscribe to what is waiting for the household, before asking —
    // so the server can tell this client without being asked.
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => { updates.push(n.params.uri); });
    await client.subscribeResource({ uri: "vouch://records/waiting" });

    const proposed = await client.callTool({
      name: "propose_purchase",
      arguments: {
        mandate_id: PROBE_MANDATE,
        product_id: "detergent-brand-c",
        quantity: 1,
        brand: "Brand C",
        confidence: 0.99,
        reason: ["probe"],
      },
    });
    const result = proposed.isError
      ? null
      : (proposed.structuredContent as { outcome: string; session_status: string; vouch: { vouch_id: string; authority: { triggered_rules: string[] } } });
    add(
      "ask for the $27.80 Brand C, claiming 0.99 confidence",
      result?.outcome === "held_for_approval" && result.session_status === "ready_for_complete",
      result ? `${result.outcome}; checkout ${result.session_status}; stopped by ${result.vouch.authority.triggered_rules.join(", ")}` : textOf(proposed)
    );

    for (let i = 0; i < 50 && !updates.includes("vouch://records/waiting"); i++) await new Promise((r) => setTimeout(r, 20));
    add(
      "be told it is waiting, without asking",
      updates.includes("vouch://records/waiting"),
      updates.length ? `notifications/resources/updated → ${[...new Set(updates)].join(", ")}` : "no notification arrived"
    );

    let refused = false;
    let refusal = "";
    try {
      const r = await client.callTool({ name: "approve_purchase", arguments: { vouch_id: result?.vouch.vouch_id ?? "x" } });
      refused = r.isError === true;
      refusal = textOf(r);
    } catch (error) {
      refused = true;
      refusal = error instanceof Error ? error.message : String(error);
    }
    add("try to approve it anyway", refused, refusal.slice(0, 120));

    if (result) {
      const why = textOf(await client.callTool({ name: "explain_vouch", arguments: { vouch_id: result.vouch.vouch_id } }));
      add("ask why it stopped", why.length > 0, why.split("\n")[0]!.slice(0, 200));
    }

    return { url, server: `${info?.name ?? "?"}`, tools, steps, passed: steps.every((s) => s.ok) };
  } finally {
    await client.close();
  }
}
