import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";

import { VouchStore } from "@vouch/db";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import {
  HttpMerchantClient,
  Study,
  VouchService,
  startVouchHttpServer,
  studySummary,
  validateStudy,
  type StudyResponse,
} from "@vouch/mcp-server";

/**
 * Study mode (BUILD_PLAN.md §3b W5c). What these defend: a real person's
 * answers are only kept with their consent and under a code, the page is not
 * trusted to send sane numbers, and the summary reports what was actually
 * said — medians and counts, never a made-up score.
 */

const good = {
  consent: true,
  participant: "P-01",
  trust_before: 2,
  trust_after: 4,
  comprehension: "It was more expensive than the limit I set",
  cost_ratio: 5,
  comment: "",
  used_chat: false,
};

describe("validateStudy", () => {
  it("keeps a complete answer and flags a real reason", () => {
    const r = validateStudy(good);
    assert.equal(r.participant, "P-01");
    assert.equal(r.named_a_real_reason, true);
    assert.equal(r.used_chat, false);
  });

  it("refuses without consent", () => {
    assert.throws(() => validateStudy({ ...good, consent: undefined }), /consent/);
    assert.throws(() => validateStudy({ ...good, consent: "yes" }), /consent/);
  });

  it("refuses a name in place of a code", () => {
    assert.throws(() => validateStudy({ ...good, participant: "Jane Wanjiru" }), /code/);
    assert.throws(() => validateStudy({ ...good, participant: "" }), /code/);
  });

  it("refuses scores off the 1-5 scale and a nonsense ratio", () => {
    for (const bad of [0, 6, 2.5, "x", null]) {
      assert.throws(() => validateStudy({ ...good, trust_before: bad }), /1 to 5/);
    }
    assert.throws(() => validateStudy({ ...good, cost_ratio: -1 }), /between/);
    assert.throws(() => validateStudy({ ...good, cost_ratio: Number.NaN }), /between/);
  });

  it("refuses an empty 'why did it stop?' answer and trims long text", () => {
    assert.throws(() => validateStudy({ ...good, comprehension: "   " }), /empty/);
    assert.equal(validateStudy({ ...good, comment: "a".repeat(5000) }).comment.length, 1000);
  });

  it("does not flag an answer that names no reason", () => {
    assert.equal(validateStudy({ ...good, comprehension: "no idea, it just didn't" }).named_a_real_reason, false);
  });
});

describe("studySummary", () => {
  const row = (before: number, afterScore: number, ratio: number, reason: boolean): StudyResponse => ({
    ...good, id: "x", created_at: "", trust_before: before, trust_after: afterScore, cost_ratio: ratio,
    named_a_real_reason: reason,
  });

  it("reports medians and counts of what people said", () => {
    const s = studySummary([row(2, 4, 5, true), row(3, 3, 2, false), row(4, 2, 10, true)]);
    assert.equal(s.n, 3);
    assert.equal(s.median_trust_before, 3);
    assert.equal(s.median_trust_after, 3);
    assert.equal(s.trust_went_up, 1);
    assert.equal(s.trust_went_down, 1);
    assert.equal(s.median_cost_ratio, 5);
    assert.equal(s.above_break_even, 2);
    assert.equal(s.named_a_real_reason, 2);
  });

  it("says nothing rather than zero when nobody has answered", () => {
    const s = studySummary([]);
    assert.equal(s.n, 0);
    assert.equal(s.median_trust_before, null);
  });
});

describe("the study routes on the household surface", () => {
  let base: string;
  let servers: Server[];
  let store: VouchStore;

  before(async () => {
    store = VouchStore.open(":memory:");
    const service = new VouchService({
      store,
      // Never called: study routes don't touch the merchant.
      merchant: new HttpMerchantClient("http://127.0.0.1:9"),
      reasoning: new RuleBasedReasoningProvider(),
      physicalEvidence: new MockRingProvider(),
    });
    const started = await startVouchHttpServer(0, { service, study: new Study(store) });
    base = started.householdUrl;
    servers = [started.server, started.householdServer];
  });

  after(() => {
    servers.forEach((s) => s.close());
    store.close();
  });

  const post = (body: unknown) =>
    fetch(`${base}/household/study`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("saves an answer and lists it back with a summary", async () => {
    const res = await post(good);
    assert.equal(res.status, 200);
    const saved = (await res.json()) as StudyResponse;
    assert.match(saved.id, /^study_/);

    const list = (await (await fetch(`${base}/household/study`)).json()) as {
      responses: StudyResponse[];
      summary: { n: number; median_trust_after: number };
    };
    assert.equal(list.summary.n, 1);
    assert.equal(list.summary.median_trust_after, 4);
    assert.equal(list.responses[0]!.participant, "P-01");
  });

  it("refuses an answer without consent, and stores nothing", async () => {
    const res = await post({ ...good, consent: false, participant: "P-02" });
    assert.equal(res.status, 400);
    const list = (await (await fetch(`${base}/household/study`)).json()) as { responses: StudyResponse[] };
    assert.ok(list.responses.every((r) => r.participant !== "P-02"));
  });

  it("is not on the MCP port", async () => {
    // The agent's port must not read people's answers.
    const mcpUrl = servers[0]!.address();
    const port = typeof mcpUrl === "object" && mcpUrl ? mcpUrl.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/household/study`);
    assert.equal(res.status, 404);
  });
});
