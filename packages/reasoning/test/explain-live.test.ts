import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { BedrockReasoningProvider, RuleBasedReasoningProvider } from "@vouch/reasoning";
import { mandate, SCENARIOS } from "./fixtures.ts";

/**
 * LIVE (npm run test:live — reads .env; `npm test` skips it). W6's "done
 * when": a model-written explanation naming the record's actual rules and
 * numbers. Measured, not demonstrated once: every scenario, several trials,
 * counting how often the model's text passed the checks and was used, and
 * how often it was set aside for the rule-based text.
 */

const key = process.env.AWS_BEARER_TOKEN_BEDROCK?.trim();
const TRIALS = 3;

describe("W6 live: the model explains real records, and is checked", { skip: key ? false : "no AWS_BEARER_TOKEN_BEDROCK" }, () => {
  it("writes explanations that pass the record checks, and names the numbers", { timeout: 180_000 }, async () => {
    const rows: string[] = [];
    let modelTotal = 0;
    for (const s of SCENARIOS) {
      let used = 0;
      const reasons: string[] = [];
      let sample = "";
      for (let t = 0; t < TRIALS; t++) {
        // A fresh provider per trial: the cache would otherwise answer trials 2 and 3.
        const p = new BedrockReasoningProvider({
          apiKey: key!,
          modelId: process.env.BEDROCK_MODEL_ID?.trim() || "us.amazon.nova-2-lite-v1:0",
          region: process.env.AWS_REGION?.trim() || "us-west-2",
          fallback: new RuleBasedReasoningProvider(),
          timeoutMs: 20_000,
        });
        const e = await p.explain({ vouch: s.vouch, mandate });
        if (e.source === "model") {
          used++;
          sample = e.text;
          for (const m of s.mustMention) assert.match(e.text, m, `${s.name}: ${e.text}`);
        } else {
          reasons.push(e.fallback_reason ?? "?");
        }
      }
      modelTotal += used;
      rows.push(`  ${s.name.padEnd(44)} ${used}/${TRIALS} model${reasons.length ? `   set aside: ${reasons.join("; ")}` : ""}\n      e.g. ${sample || "(none)"}`);
    }
    console.log(`\nW6 — model-written explanations, ${SCENARIOS.length} kinds of record × ${TRIALS} trials\n${rows.join("\n")}\n  total ${modelTotal}/${SCENARIOS.length * TRIALS}\n`);
    // The bar: the model's text is usable most of the time. When it is not,
    // the household still gets the rule-based text — the checks are the point.
    assert.ok(modelTotal >= Math.ceil(SCENARIOS.length * TRIALS * 0.6), `only ${modelTotal} model explanations passed the checks`);
  });
});
