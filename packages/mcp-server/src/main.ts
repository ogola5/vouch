import { VouchStore } from "@vouch/db";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import {
  MockRingProvider,
  RealRingProvider,
  RingEventStore,
  createRingWebhookServer,
} from "@vouch/ring-integration";
import { HttpMerchantClient } from "./merchantClient.ts";
import { VouchService } from "./service.ts";
import { startVouchHttpServer } from "./server.ts";

/**
 * THE COMPOSITION ROOT. This is the only file in the project that decides
 * which implementation of each seam is in play, which is what makes the
 * interface-first decisions in BUILD_PLAN.md section 1 pay off:
 *
 *   ReasoningProvider       RuleBasedReasoningProvider -> BedrockReasoningProvider
 *   PhysicalEvidenceProvider MockRingProvider          -> RealRingProvider
 *
 * Both swaps are a changed constructor call here and nothing else. No caller
 * of either interface needs to know.
 *
 * Keep the README's real-vs-simulated table in step with this file — it is
 * the authoritative answer to "which parts are real", and the submission is
 * required to state that plainly (brief section 9).
 */

const port = Number(process.env.MCP_PORT ?? 4020);
const merchantUrl = process.env.MERCHANT_URL ?? "http://127.0.0.1:4010";
const dbPath = process.env.VOUCH_DB ?? "vouch.db";

const store = VouchStore.open(dbPath);
const reasoning = new RuleBasedReasoningProvider();

/*
 * The Ring swap the interface-first decision in BUILD_PLAN.md §1 was written
 * to make cheap — and it is: a constructor call, with no caller changes.
 *
 * OPT-IN, NOT AUTOMATIC, and the reason matters. Selecting RealRingProvider
 * merely because an HMAC key is present would silently break the demo: with
 * no account linking there are no deliveries, the event store stays empty,
 * and every purchase would report "unconfirmed" — including the corroborated
 * beat the demo script needs. A key in .env means "I have credentials", not
 * "events are flowing". So real mode is chosen explicitly with RING_MODE=real
 * and the mock stays the default.
 */
const ringMode = process.env.RING_MODE === "real" ? "real" : "mock";
const ringStore = new RingEventStore();
const physicalEvidence =
  ringMode === "real" ? new RealRingProvider({ store: ringStore }) : new MockRingProvider();

if (ringMode === "real") {
  const secret = process.env.RING_HMAC_KEY ?? process.env.HMAC_SIGNATURE_KEY;
  if (!secret) {
    // Fail loudly rather than accepting unverified deliveries. A receiver
    // with no secret cannot tell Ring from anyone who found the URL.
    console.error("[mcp-server] RING_MODE=real needs RING_HMAC_KEY (or HMAC_SIGNATURE_KEY). Refusing to start.");
    process.exit(1);
  }
  const ringPort = Number(process.env.RING_WEBHOOK_PORT ?? 4110);
  createRingWebhookServer({ store: ringStore, secret }).listen(ringPort, "0.0.0.0", () => {
    console.log(`[mcp-server] ring webhook   http://0.0.0.0:${ringPort}/ring/webhook`);
  });
}

const service = new VouchService({
  store,
  merchant: new HttpMerchantClient(merchantUrl),
  reasoning,
  physicalEvidence,
});

/*
 * Exposure settings. Loopback by default; the Alexa+ bridge needs 0.0.0.0
 * behind a tunnel, and that is precisely when the host allow-list stops being
 * optional — without it, a public MCP endpoint answers to any Host header and
 * is reachable by DNS rebinding from a browser on the operator's network.
 */
const host = process.env.MCP_HOST ?? "127.0.0.1";
const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

if (host !== "127.0.0.1" && allowedHosts.length === 0) {
  console.error(
    `[mcp-server] MCP_HOST=${host} exposes this server beyond loopback, but MCP_ALLOWED_HOSTS is empty.\n` +
      `            Set it to the hostname you are serving, e.g.\n` +
      `            MCP_ALLOWED_HOSTS=your-tunnel.trycloudflare.com\n` +
      `            Refusing to start: an unrestricted public MCP endpoint is not something to do by accident.`
  );
  process.exit(1);
}

const { url, householdUrl } = await startVouchHttpServer(port, {
  service,
  host,
  allowedHosts,
  allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  householdPort: Number(process.env.HOUSEHOLD_PORT ?? 4021),
});

console.log(`[mcp-server] Streamable HTTP  ${url}/mcp   (bound ${host})`);
console.log(`[mcp-server] household        ${householdUrl}/household   (loopback only, never tunnel this)`);
if (allowedHosts.length > 0) {
  console.log(`[mcp-server] allowed hosts    ${allowedHosts.join(", ")}  (DNS-rebinding protection on)`);
}
console.log(`[mcp-server] merchant         ${merchantUrl}`);
console.log(`[mcp-server] database         ${dbPath}`);
console.log(`[mcp-server] reasoning        RuleBasedReasoningProvider (no model call)`);
// Derived from the choice above rather than hardcoded. A banner that names
// the wrong provider is worse than none: it is read during a demo and
// believed, and this one claimed "Mock" while the real receiver was running.
console.log(
  `[mcp-server] physical evidence ${
    ringMode === "real"
      ? "RealRingProvider (verifying signed webhooks; empty until deliveries arrive)"
      : "MockRingProvider (scriptable, not a real doorbell)"
  }`
);
