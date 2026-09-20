import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";

import {
  createRingWebhookServer,
  parseRingWebhook,
  RealRingProvider,
  RingEventStore,
  verifyRingSignature,
} from "@vouch/ring-integration";

/**
 * Signature verification is the security-relevant piece of this integration,
 * so it is tested directly as well as over HTTP.
 *
 * Worth being clear about what these prove and what they do not. They prove
 * the receiving code is correct: a genuine signature is accepted, a forged
 * one is rejected, a body altered in transit is rejected, and events
 * correlate against the right window. They do NOT prove Ring has ever sent us
 * anything — account linking was not completed (BUILD_PLAN.md §7), so the
 * deliveries here are signed by the test rather than by Ring.
 */

const SECRET = "test-hmac-signing-key";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function motionBody(overrides: { sub_type?: string; type?: string; id?: string } = {}): string {
  return JSON.stringify({
    meta: { request_id: `req-${Math.random().toString(16).slice(2)}`, time: new Date().toISOString() },
    data: {
      type: overrides.type ?? "motion_detected",
      id: overrides.id ?? "evt-1",
      attributes: { device_id: "dev-front-door", sub_type: overrides.sub_type ?? "human", component_ids: [0] },
    },
  });
}

describe("signature verification", () => {
  it("accepts a correctly signed body", () => {
    const body = motionBody();
    assert.deepEqual(verifyRingSignature(body, sign(body), SECRET), { valid: true });
  });

  it("rejects a body altered after signing", () => {
    const body = motionBody();
    const signature = sign(body);
    // One character changed anywhere invalidates the digest — which is the
    // property that makes the signature worth checking at all.
    const tampered = body.replace('"human"', '"vehicle"');
    assert.deepEqual(verifyRingSignature(tampered, signature, SECRET), {
      valid: false,
      reason: "mismatch",
    });
  });

  it("rejects a signature made with the wrong key", () => {
    const body = motionBody();
    const result = verifyRingSignature(body, sign(body, "someone-elses-key"), SECRET);
    assert.deepEqual(result, { valid: false, reason: "mismatch" });
  });

  it("accepts the bare hex form as well as the sha256= prefix", () => {
    const body = motionBody();
    const bare = sign(body).slice("sha256=".length);
    assert.deepEqual(verifyRingSignature(body, bare, SECRET), { valid: true });
  });

  it("reports missing pieces distinctly instead of throwing", () => {
    const body = motionBody();
    assert.deepEqual(verifyRingSignature(body, sign(body), undefined), {
      valid: false,
      reason: "no_secret",
    });
    assert.deepEqual(verifyRingSignature(body, undefined, SECRET), {
      valid: false,
      reason: "missing_header",
    });
    // Non-hex must be rejected as malformed rather than reaching
    // Buffer.from(..., "hex"), which silently truncates garbage.
    assert.deepEqual(verifyRingSignature(body, "sha256=not-hex-at-all", SECRET), {
      valid: false,
      reason: "malformed",
    });
  });

  it("does not throw on a signature of the wrong length", () => {
    // timingSafeEqual throws when buffers differ in length, so an attacker
    // sending a short signature could otherwise turn a rejection into a 500.
    const body = motionBody();
    assert.doesNotThrow(() => verifyRingSignature(body, "sha256=abcd", SECRET));
  });
});

describe("parsing a delivery", () => {
  it("pulls out the fields the correlator needs", () => {
    const event = parseRingWebhook(motionBody({ sub_type: "human" }));
    assert.equal(event.type, "motion_detected");
    assert.equal(event.device_id, "dev-front-door");
    assert.equal(event.classification, "human");
    assert.ok(event.received_at);
  });

  it("maps an unfamiliar classification to 'other', never to 'human'", () => {
    // Defaulting an unknown classification to human would let a future Ring
    // sub_type silently corroborate a delivery it should not.
    assert.equal(parseRingWebhook(motionBody({ sub_type: "spaceship" })).classification, "other");
  });

  it("keeps an unknown event type rather than rejecting the delivery", () => {
    // Rejecting would empty the store, and an empty store reports
    // "unconfirmed" — which reads as "no delivery" rather than "we broke".
    assert.equal(parseRingWebhook(motionBody({ type: "some_future_event" })).type, "some_future_event");
  });

  it("refuses a body that is not a Ring envelope", () => {
    assert.throws(() => parseRingWebhook("{}"), /expected \{ meta, data/);
    assert.throws(() => parseRingWebhook("not json"), /not JSON/);
  });
});

describe("correlating an event against a delivery window", () => {
  function providerWith(events: { type: string; classification: string | null; minutesAgo: number }[]) {
    const store = new RingEventStore();
    for (const [index, spec] of events.entries()) {
      store.add({
        event_id: `evt-${index}`,
        request_id: `req-${index}`,
        type: spec.type,
        device_id: "dev-front-door",
        classification: spec.classification as never,
        occurred_at: null,
        received_at: new Date(Date.now() - spec.minutesAgo * 60_000).toISOString(),
      });
    }
    return new RealRingProvider({ store });
  }

  const request = { order_id: "order-1", expected_around: new Date().toISOString(), window_minutes: 30 };

  it("reports unconfirmed when nothing happened at the door", async () => {
    const evidence = await providerWith([]).correlateDelivery(request);
    assert.equal(evidence.correlation_status, "unconfirmed");
    assert.equal(evidence.ring_event_id, null);
  });

  it("corroborates a person at the door inside the window", async () => {
    const evidence = await providerWith([
      { type: "motion_detected", classification: "human", minutesAgo: 5 },
    ]).correlateDelivery(request);

    assert.equal(evidence.correlation_status, "corroborated");
    assert.equal(evidence.event_type, "motion_detected");
    assert.equal(evidence.classification, "human");
  });

  it("does NOT corroborate on a vehicle alone, but still shows what it saw", async () => {
    // The failure BUILD_PLAN §1 flagged: a car passing is motion, and is not
    // evidence a parcel was dropped. The event is still attached so the
    // household can see what was seen and judge it themselves.
    const evidence = await providerWith([
      { type: "motion_detected", classification: "vehicle", minutesAgo: 3 },
    ]).correlateDelivery(request);

    assert.equal(evidence.correlation_status, "unconfirmed");
    assert.equal(evidence.classification, "vehicle");
    assert.ok(evidence.ring_event_id, "the evidence is shown even when it does not corroborate");
  });

  it("ignores events outside the window", async () => {
    const evidence = await providerWith([
      { type: "motion_detected", classification: "human", minutesAgo: 180 },
    ]).correlateDelivery(request);
    assert.equal(evidence.correlation_status, "unconfirmed");
  });

  it("prefers a doorbell press over nearby motion", async () => {
    const evidence = await providerWith([
      { type: "motion_detected", classification: "animal", minutesAgo: 8 },
      { type: "button_press", classification: null, minutesAgo: 4 },
    ]).correlateDelivery(request);

    assert.equal(evidence.event_type, "button_press");
    assert.equal(evidence.correlation_status, "corroborated");
  });

  it("never reports anything but the three honest states", async () => {
    // Guardrail (brief §9): never a boolean "delivered".
    const evidence = await providerWith([
      { type: "motion_detected", classification: "human", minutesAgo: 1 },
    ]).correlateDelivery(request);
    assert.ok(["corroborated", "unconfirmed", "not_applicable"].includes(evidence.correlation_status));
  });
});

describe("over HTTP — the endpoint Ring would post to", () => {
  let server: Server;
  let url: string;
  const store = new RingEventStore();

  before(async () => {
    server = createRingWebhookServer({ store, secret: SECRET });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        resolve();
      });
    });
  });

  after(() => server.close());

  async function post(body: string, signature: string | undefined): Promise<number> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (signature) headers["X-Signature"] = signature;
    return (await fetch(`${url}/ring/webhook`, { method: "POST", headers, body })).status;
  }

  it("accepts and stores a correctly signed delivery", async () => {
    store.clear();
    const body = motionBody();
    assert.equal(await post(body, sign(body)), 200);
    assert.equal(store.all().length, 1);
    assert.equal(store.all()[0]?.classification, "human");
  });

  it("rejects an unsigned delivery and stores nothing", async () => {
    store.clear();
    assert.equal(await post(motionBody(), undefined), 401);
    assert.equal(store.all().length, 0, "an unverified delivery must never become evidence");
  });

  it("rejects a forged signature", async () => {
    store.clear();
    const body = motionBody();
    assert.equal(await post(body, sign(body, "wrong-key")), 401);
    assert.equal(store.all().length, 0);
  });

  it("rejects a body altered in transit", async () => {
    store.clear();
    const body = motionBody({ sub_type: "vehicle" });
    const signature = sign(body);
    assert.equal(await post(body.replace("vehicle", "human"), signature), 401);
    assert.equal(store.all().length, 0);
  });

  it("gives an unauthenticated caller no detail about why it failed", async () => {
    const response = await fetch(`${url}/ring/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: motionBody(),
    });
    const text = await response.text();
    // Saying whether the header was missing, malformed or merely wrong would
    // hand a prober a way to narrow down the secret.
    assert.equal(text, JSON.stringify({ status: "unauthorized" }));
  });

  it("returns 400, not 500, for a signed body that is not a Ring envelope", async () => {
    store.clear();
    const body = JSON.stringify({ hello: "world" });
    assert.equal(await post(body, sign(body)), 400);
  });
});
