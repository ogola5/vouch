import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Mandate, Vouch } from "@vouch/shared";
import { BedrockReasoningProvider, RuleBasedReasoningProvider, checkExplanation, explanationFacts } from "@vouch/reasoning";

/**
 * W6: the model writes the "why", and is checked rather than trusted. These
 * run with a fake fetch — the live call is test/explain-live.test.ts.
 */

const NOW = "2026-10-14T10:00:00.000Z";

const mandate = Mandate.parse({
  mandate_id: "m_detergent",
  goal: "Keep laundry detergent stocked",
  constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
  requires_approval_if: ["price > max_price", "new_brand"],
  authority_type: "explicit",
  confidence_threshold: 0.85,
  baseline_confidence_threshold: 0.85,
  history: {},
  created_at: NOW,
  updated_at: NOW,
});

function vouch(status: "PendingApproval" | "Complete" | "Failed", over: Record<string, unknown> = {}) {
  return Vouch.parse({
    vouch_id: `v_${status}`,
    created_at: NOW,
    intent: "restock detergent",
    authority: {
      mandate_id: "m_detergent",
      within_bounds: status !== "PendingApproval",
      triggered_rules: status === "PendingApproval" ? ["price > max_price", "new_brand"] : [],
      checks: [
        { rule: "price > max_price", passed: status !== "PendingApproval", detail: status === "PendingApproval" ? "$27.99 > $15.00" : "$12.49 ≤ $15.00" },
        { rule: "new_brand", passed: status !== "PendingApproval", detail: status === "PendingApproval" ? "Brand C is not Brand A or Brand B" : "Brand A is your usual" },
      ],
    },
    decision: { product: status === "PendingApproval" ? "Brand C Detergent" : "Brand A Detergent", price: status === "Failed" ? null : status === "PendingApproval" ? 27.99 : 12.49, reason: ["running low"] },
    failure: status === "Failed" ? { stage: "checkout", message: "the store answered 503" } : null,
    action: { ucp_session_id: null, status },
    evidence: {
      digital: { order_id: null, timestamp: NOW, payment_token_ref: null },
      physical: { ring_event_id: null, correlation_status: status === "Complete" ? "unconfirmed" : "not_applicable" },
    },
    confidence: "high",
    user_controls: ["explain"],
    ...over,
  });
}

/** A fetch that answers with `text` and remembers what it was asked. */
function fakeFetch(answer: string | Error | number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response("nope", { status: answer });
    return new Response(JSON.stringify({ output: { message: { content: [{ text: answer }] } } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const provider = (answer: string | Error | number) => {
  const f = fakeFetch(answer);
  return {
    p: new BedrockReasoningProvider({
      apiKey: "test-key",
      modelId: "us.amazon.nova-2-lite-v1:0",
      region: "us-west-2",
      fallback: new RuleBasedReasoningProvider(),
      fetchImpl: f.impl,
    }),
    calls: f.calls,
  };
};

const GOOD_HELD =
  "I stopped before buying Brand C Detergent at $27.99 because it is over your $15.00 limit and is not a brand you've approved. It's waiting for you.";

describe("BedrockReasoningProvider", () => {
  it("uses the model's text when it passes every check, calling Converse with the key as a bearer token", async () => {
    const { p, calls } = provider(GOOD_HELD);
    const e = await p.explain({ vouch: vouch("PendingApproval"), mandate });
    assert.equal(e.source, "model");
    assert.equal(e.text, GOOD_HELD);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/us.amazon.nova-2-lite-v1%3A0/converse");
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer test-key");
    const body = JSON.parse(String(calls[0]!.init.body)) as { messages: { content: { text: string }[] }[] };
    // The model is given the record's facts, including the exact comparison.
    assert.match(body.messages[0]!.content[0]!.text, /\$27\.99 > \$15\.00/);
  });

  it("asks once per record state, not on every look", async () => {
    const { p, calls } = provider(GOOD_HELD);
    const v = vouch("PendingApproval");
    await p.explain({ vouch: v, mandate });
    await p.explain({ vouch: v, mandate });
    assert.equal(calls.length, 1);
  });

  it("falls back to the rule-based text when the model is down, errors, or times out — and says why", async () => {
    for (const answer of [new Error("socket hang up"), 500, 403]) {
      const { p } = provider(answer);
      const e = await p.explain({ vouch: vouch("PendingApproval"), mandate });
      assert.equal(e.source, "rules");
      assert.match(e.fallback_reason ?? "", /model unavailable/);
      assert.match(e.text, /I stopped before buying Brand C Detergent at \$27\.99/);
    }
  });

  it("rejects a model text that invents a number", async () => {
    const { p } = provider(
      "I stopped before buying Brand C Detergent at $27.99, which is 87% over your limit and a brand you haven't approved. It's waiting for you."
    );
    const e = await p.explain({ vouch: vouch("PendingApproval"), mandate });
    assert.equal(e.source, "rules");
    assert.match(e.fallback_reason ?? "", /number not in the record: 87/);
  });

  it("rejects a held explanation that does not say what stopped it", async () => {
    const { p } = provider("I paused on Brand C Detergent at $27.99 and it's waiting for you.");
    const e = await p.explain({ vouch: vouch("PendingApproval"), mandate });
    assert.equal(e.source, "rules");
    assert.match(e.fallback_reason ?? "", /does not say what stopped it/);
  });

  it("rejects a claim of delivery, and a purchase that did not happen", async () => {
    let { p } = provider("I bought Brand A Detergent at $12.49, within your $15.00 limit, and it was delivered.");
    assert.match((await p.explain({ vouch: vouch("Complete"), mandate })).fallback_reason ?? "", /claims a delivery/);

    ({ p } = provider("I bought Brand C Detergent at $27.99, over your $15.00 limit, from a new brand."));
    assert.match((await p.explain({ vouch: vouch("PendingApproval"), mandate })).fallback_reason ?? "", /claims a purchase/);
  });

  it("never lets the model move the threshold", async () => {
    const { p, calls } = provider(GOOD_HELD);
    const rules = new RuleBasedReasoningProvider();
    const event = { kind: "dispute" as const };
    assert.deepEqual(await p.adjustConfidenceThreshold({ mandate, event }), await rules.adjustConfidenceThreshold({ mandate, event }));
    assert.equal(calls.length, 0);
  });
});

describe("checkExplanation", () => {
  const facts = explanationFacts(vouch("Complete"), mandate);
  it("accepts the record's own numbers, written the ways people write them", () => {
    assert.equal(checkExplanation("I bought Brand A Detergent for $12.49, under your $15 limit.", facts), null);
  });
  it("does not need a price on a failed attempt, but still forbids claiming a purchase", () => {
    const failed = explanationFacts(vouch("Failed"), mandate);
    assert.equal(checkExplanation("I tried to buy Brand A Detergent, but the store answered 503. Nothing was bought.", failed), null);
    assert.match(checkExplanation("I bought Brand A Detergent.", failed) ?? "", /claims a purchase/);
  });
});
