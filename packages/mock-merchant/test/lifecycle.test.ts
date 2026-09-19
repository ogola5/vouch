import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";

import { UCP_HEADERS, ucpAgentHeader, toMinorUnits } from "@vouch/shared";
import type { UcpProfile } from "@vouch/shared";
import { Merchant, UcpError, startMerchantServer } from "@vouch/mock-merchant";

/**
 * The merchant's job in this project is to be a faithful UCP artifact, so
 * these tests are about the state machine rather than about shopping. The
 * property the rest of the system leans on is that `ready_for_complete`
 * genuinely means "every requirement satisfied, order not placed" — if that
 * status could be reached loosely, the gate's held-session evidence would be
 * worth nothing.
 */

function fullyPrepared(merchant: Merchant, productId = "detergent-brand-a", quantity = 1) {
  const created = merchant.createSession({
    line_items: [{ item: { id: productId }, quantity }],
    currency: "USD",
  });
  const method = created.fulfillment!.methods[0]!;
  return merchant.updateSession(created.id, {
    buyer: { email: "household@vouch.test" },
    fulfillment: {
      methods: [
        {
          ...method,
          selected_destination_id: "home",
          destinations: [{ id: "home", postal_code: "98109", address_country: "US" }],
          groups: method.groups.map((g) => ({ ...g, selected_option_id: "standard" })),
        },
      ],
    },
    payment: {
      instruments: [
        { id: "instrument_demo", handler_id: "dev.vouch.mock_pay", type: "card", selected: true },
      ],
    },
  });
}

describe("UCP session status is derived, never asserted", () => {
  it("starts incomplete and says exactly what is missing", () => {
    const merchant = new Merchant();
    const session = merchant.createSession({
      line_items: [{ item: { id: "detergent-brand-a" }, quantity: 1 }],
    });

    assert.equal(session.status, "incomplete");
    const complaints = (session.messages ?? []).map((m) => m.content).join(" | ");
    assert.match(complaints, /buyer\.email/);
    assert.match(complaints, /payment instrument/);
    assert.match(complaints, /fulfillment destination/);
  });

  it("reaches ready_for_complete only once every requirement is satisfied", () => {
    const merchant = new Merchant();
    const session = fullyPrepared(merchant);

    assert.equal(session.status, "ready_for_complete");
    assert.deepEqual(session.messages, []);
    assert.equal(session.order, undefined, "ready_for_complete must not have placed an order");
  });

  it("falls back out of ready_for_complete when a requirement is withdrawn", () => {
    const merchant = new Merchant();
    const ready = fullyPrepared(merchant);
    assert.equal(ready.status, "ready_for_complete");

    // Deselecting the payment instrument must un-ready the session. A status
    // that stuck once reached would let the gate be bypassed by a session
    // that was briefly valid.
    const after = merchant.updateSession(ready.id, {
      payment: {
        instruments: [
          {
            id: "instrument_demo",
            handler_id: "dev.vouch.mock_pay",
            type: "card",
            selected: false,
          },
        ],
      },
    });
    assert.equal(after.status, "incomplete");
  });
});

describe("complete and cancel", () => {
  it("refuses to complete a session that is not ready", () => {
    const merchant = new Merchant();
    const session = merchant.createSession({
      line_items: [{ item: { id: "detergent-brand-a" }, quantity: 1 }],
    });

    assert.throws(
      () => merchant.completeSession(session.id),
      (error: unknown) =>
        error instanceof UcpError &&
        error.status === 409 &&
        error.code === "not_ready_for_complete"
    );
  });

  it("mints an order on complete, and is idempotent", () => {
    const merchant = new Merchant();
    const ready = fullyPrepared(merchant);

    const completed = merchant.completeSession(ready.id);
    assert.equal(completed.status, "completed");
    assert.ok(completed.order?.id);

    const again = merchant.completeSession(ready.id);
    assert.equal(again.order?.id, completed.order?.id, "completing twice must not place a second order");
  });

  it("will not cancel a completed session, nor update a terminal one", () => {
    const merchant = new Merchant();
    const ready = fullyPrepared(merchant);
    merchant.completeSession(ready.id);

    assert.throws(() => merchant.cancelSession(ready.id), /already_completed|cannot be canceled/);
    assert.throws(() => merchant.updateSession(ready.id, { buyer: { email: "x@y.test" } }), UcpError);
  });
});

describe("money stays in minor units", () => {
  it("totals a multi-quantity line item without drifting into decimals", () => {
    const merchant = new Merchant();
    merchant.catalog.setPriceMajor("detergent-brand-a", 12.49);
    const session = fullyPrepared(merchant, "detergent-brand-a", 2);

    const subtotal = session.totals.find((t) => t.type === "subtotal");
    assert.equal(subtotal?.amount, toMinorUnits(24.98, "USD"));
    assert.ok(Number.isInteger(session.totals.find((t) => t.type === "total")!.amount));
  });
});

describe("over HTTP — the boundary the MCP server really crosses", () => {
  const started = startMerchantServer(0);
  after(async () => {
    const { server } = await started;
    server.close();
  });

  it("serves a discovery document declaring the checkout capability", async () => {
    const { url } = await started;
    const profile = (await (await fetch(`${url}/.well-known/ucp`)).json()) as UcpProfile;

    assert.equal(profile.ucp.version, "2026-04-08");
    assert.ok(profile.ucp.capabilities["dev.ucp.shopping.checkout"]);
    assert.equal(profile.ucp.services["dev.ucp.shopping"]?.[0]?.transport, "rest");
  });

  it("rejects a checkout request with no UCP-Agent header", async () => {
    const { url } = await started;
    const response = await fetch(`${url}/ucp/checkout-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line_items: [{ item: { id: "detergent-brand-a" }, quantity: 1 }] }),
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "missing_ucp_agent");
  });

  it("honours Idempotency-Key on create", async () => {
    const { url } = await started;
    const headers = {
      "Content-Type": "application/json",
      [UCP_HEADERS.agent]: ucpAgentHeader("https://vouch.test/agent-profile"),
      [UCP_HEADERS.idempotencyKey]: "key-123",
    };
    const body = JSON.stringify({
      line_items: [{ item: { id: "detergent-brand-a" }, quantity: 1 }],
    });

    const post = async () =>
      (await (
        await fetch(`${url}/ucp/checkout-sessions`, { method: "POST", headers, body })
      ).json()) as { id: string };

    const first = await post();
    const second = await post();

    assert.equal(first.id, second.id, "a repeated Idempotency-Key must not open a second session");
  });
});
