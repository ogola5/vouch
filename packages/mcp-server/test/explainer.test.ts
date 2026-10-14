import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";

import { VouchStore } from "@vouch/db";
import { startMerchantServer } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider, type Explanation, type ExplainVouchInput } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import { HttpMerchantClient, VouchService } from "@vouch/mcp-server";

/**
 * W6's seam: the model explains when someone ASKS, and never sits in the
 * purchase path. A fast-forward through a month must not wait on a model
 * call per purchase, and no purchase may depend on a model being up.
 */

let merchantServer: Server;
let store: VouchStore;
let service: VouchService;
const asked: string[] = [];

before(async () => {
  const merchant = await startMerchantServer(0);
  merchantServer = merchant.server;
  store = VouchStore.open(":memory:");
  const rules = new RuleBasedReasoningProvider();
  service = new VouchService({
    store,
    merchant: new HttpMerchantClient(merchant.url),
    reasoning: rules,
    explainer: {
      explainVouch: (input: ExplainVouchInput) => rules.explainVouch(input),
      adjustConfidenceThreshold: (input) => rules.adjustConfidenceThreshold(input),
      explain: async ({ vouch }): Promise<Explanation> => {
        asked.push(vouch.vouch_id);
        return { text: "written by the stand-in model", source: "model" };
      },
    },
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
});

after(() => {
  merchantServer.close();
  store.close();
});

describe("the explainer is used on request, never in the purchase path", () => {
  it("does not call it while buying or holding", async () => {
    const bought = await service.proposePurchase({ mandate_id: "m_detergent", product_id: "detergent-brand-a", quantity: 1, brand: "Brand A", confidence: 0.92, reason: ["price_drop", "preferred_brand"] });
    const held = await service.proposePurchase({ mandate_id: "m_detergent", product_id: "detergent-brand-c", quantity: 1, brand: "Brand C", confidence: 0.95, reason: ["in_stock"] });
    assert.equal(bought.outcome, "completed");
    assert.equal(held.outcome, "held_for_approval");
    // The purchase results still carry an explanation — the deterministic one.
    assert.match(held.explanation, /stopped before buying/);
    assert.deepEqual(asked, []);

    const e = await service.explainVouch(held.vouch.vouch_id);
    assert.equal(e.source, "model");
    assert.deepEqual(asked, [held.vouch.vouch_id]);
  });
});
