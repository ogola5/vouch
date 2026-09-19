import { VouchStore } from "@vouch/db";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
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
const physicalEvidence = new MockRingProvider();

const service = new VouchService({
  store,
  merchant: new HttpMerchantClient(merchantUrl),
  reasoning,
  physicalEvidence,
});

const { url } = await startVouchHttpServer(port, { service });

console.log(`[mcp-server] Streamable HTTP  ${url}/mcp`);
console.log(`[mcp-server] merchant         ${merchantUrl}`);
console.log(`[mcp-server] database         ${dbPath}`);
console.log(`[mcp-server] reasoning        RuleBasedReasoningProvider (no model call)`);
console.log(`[mcp-server] physical evidence MockRingProvider (scriptable, not a real doorbell)`);
