import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";

import { VouchStore } from "@vouch/db";
import { startMerchantServer } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { HttpMerchantClient, VouchService, probeMcp, startVouchHttpServer } from "@vouch/mcp-server";

/**
 * S3: an outside MCP client, knowing only the URL, meets the same gate and
 * finds no way around it — run against a real server over real HTTP.
 */

let servers: Server[] = [];
let store: VouchStore;
let url: string;

before(async () => {
  const merchant = await startMerchantServer(0);
  store = VouchStore.open(":memory:");
  const service = new VouchService({
    store,
    merchant: new HttpMerchantClient(merchant.url),
    reasoning: new RuleBasedReasoningProvider(),
    physicalEvidence: new MockRingProvider(),
  });
  const started = await startVouchHttpServer(0, { service });
  servers = [merchant.server, started.server, started.householdServer];
  url = `${started.url}/mcp`;
});

after(() => {
  servers.forEach((s) => s.close());
  store.close();
});

describe("an outside MCP client", () => {
  it("connects cold, is held by the gate, and cannot approve itself — twice over", async () => {
    for (let run = 1; run <= 2; run++) {
      const report = await probeMcp(url);
      const failed = report.steps.filter((s) => !s.ok);
      assert.deepEqual(failed, [], `run ${run}: ${JSON.stringify(failed)}`);
      assert.equal(report.passed, true);
      assert.ok(!report.tools.some((t) => /approve/.test(t)));
      const ask = report.steps.find((s) => s.step.startsWith("ask for the $27.80"))!;
      assert.match(ask.detail, /held_for_approval; checkout ready_for_complete/);
    }
    // Nothing was bought: every probe purchase is still waiting.
    const probes = store.listVouches({ mandate_id: "m_probe", limit: 10 });
    assert.equal(probes.length, 2);
    assert.ok(probes.every((v) => v.action.status === "PendingApproval" && v.evidence.digital.order_id === null));
  });
});
