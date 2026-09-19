import { randomUUID } from "node:crypto";
import {
  UCP_CHECKOUT_CAPABILITY,
  UCP_VERSION,
  UcpCreateCheckoutRequest,
  UcpUpdateCheckoutRequest,
  type UcpCheckoutSession,
  type UcpEnvelope,
  type UcpLineItem,
  type UcpMessage,
  type UcpProfile,
  type UcpTotal,
} from "@vouch/shared";
import { Catalog } from "./catalog.ts";

/**
 * The mock merchant's checkout lifecycle, implemented against the published
 * UCP REST binding (see packages/shared/src/ucp.ts for the spec reference).
 *
 * WHY THIS IS A SEPARATE SERVICE and not a function inside the MCP server:
 * UCP publishes its own MCP binding and a /.well-known/ucp discovery
 * document, so a conformant merchant has a surface fixed by the
 * specification rather than chosen by us. Collapsing it inward would delete
 * the thing that makes "we implemented the real published spec, both sides"
 * checkable in a code walkthrough. See BUILD_PLAN.md section 2.
 *
 * WHAT IS REAL AND WHAT IS SIMULATED, stated plainly because the submission
 * has to (brief section 9): the session lifecycle, its state machine, its
 * status vocabulary, the totals arithmetic in minor units, the required
 * headers and the discovery document are all real implementations of the
 * published spec. No payment is processed and no goods exist — completing a
 * session mints an order id and returns it. That is the simulated half.
 */

/** Demo sales-tax rate. A real merchant computes this per destination. */
const DEMO_TAX_RATE = 0.0875;

/**
 * Fields are declared and assigned explicitly rather than as constructor
 * parameter properties. Node 24's type stripping is strip-only — it erases
 * annotations without transforming syntax — so `constructor(readonly x: T)`
 * is a runtime SyntaxError in any file Node executes directly, which
 * includes `npm run dev:mock-merchant` and every test. The whole project
 * avoids parameter properties for that reason.
 */
export class UcpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "UcpError";
    this.status = status;
    this.code = code;
  }
}

function envelope(): UcpEnvelope {
  return {
    version: UCP_VERSION,
    capabilities: {
      [UCP_CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }],
    },
    payment_handlers: {
      "dev.vouch.mock_pay": [
        {
          id: "dev.vouch.mock_pay",
          version: UCP_VERSION,
          available_instruments: [{ type: "card" }],
        },
      ],
    },
  };
}

export interface MerchantOptions {
  catalog?: Catalog;
  /** Overridable so tests get deterministic ids instead of random UUIDs. */
  idFactory?: () => string;
}

export class Merchant {
  readonly catalog: Catalog;
  private readonly newId: () => string;
  private sessions = new Map<string, UcpCheckoutSession>();
  /** Idempotency-Key -> session id, per the spec's required header. */
  private idempotency = new Map<string, string>();

  constructor(options: MerchantOptions = {}) {
    this.catalog = options.catalog ?? new Catalog();
    this.newId = options.idFactory ?? (() => randomUUID());
  }

  /* ---------------------------------------------------------------------
   * Discovery
   * ------------------------------------------------------------------ */

  profile(baseUrl: string): UcpProfile {
    return {
      ucp: {
        version: UCP_VERSION,
        services: {
          "dev.ucp.shopping": [
            {
              version: UCP_VERSION,
              transport: "rest",
              endpoint: `${baseUrl.replace(/\/$/, "")}/ucp`,
            },
          ],
        },
        capabilities: { [UCP_CHECKOUT_CAPABILITY]: [{ version: UCP_VERSION }] },
        payment_handlers: envelope().payment_handlers,
      },
    };
  }

  /* ---------------------------------------------------------------------
   * Lifecycle
   * ------------------------------------------------------------------ */

  createSession(body: unknown, idempotencyKey?: string): UcpCheckoutSession {
    if (idempotencyKey !== undefined) {
      const existing = this.idempotency.get(idempotencyKey);
      if (existing !== undefined) {
        return this.requireSession(existing);
      }
    }

    const parsed = UcpCreateCheckoutRequest.safeParse(body);
    if (!parsed.success) {
      throw new UcpError(400, "invalid_request", parsed.error.message);
    }

    const currency = parsed.data.currency ?? "USD";
    const lineItems: UcpLineItem[] = parsed.data.line_items.map((requested) => {
      const product = this.catalog.get(requested.item.id);
      if (!product) {
        throw new UcpError(404, "item_not_found", `No item with id "${requested.item.id}"`);
      }
      if (product.currency !== currency) {
        throw new UcpError(
          400,
          "currency_mismatch",
          `Item "${product.id}" is priced in ${product.currency}, session is ${currency}`
        );
      }
      return {
        id: this.newId(),
        item: { id: product.id, title: product.title, price: product.price },
        quantity: requested.quantity,
        totals: [{ type: "subtotal", amount: product.price * requested.quantity }],
      };
    });

    const session: UcpCheckoutSession = {
      ucp: envelope(),
      id: this.newId(),
      status: "incomplete",
      currency,
      line_items: lineItems,
      buyer: parsed.data.buyer,
      totals: [],
      fulfillment: {
        methods: [
          {
            id: this.newId(),
            type: "shipping",
            line_item_ids: lineItems.map((li) => li.id),
            destinations: [],
            groups: [
              {
                id: this.newId(),
                line_item_ids: lineItems.map((li) => li.id),
                options: [
                  {
                    id: "standard",
                    title: "Standard (3-5 days)",
                    totals: [{ type: "total", amount: 0 }],
                  },
                  {
                    id: "express",
                    title: "Express (1 day)",
                    totals: [{ type: "total", amount: 599 }],
                  },
                ],
              },
            ],
          },
        ],
      },
      payment: { instruments: [] },
    };

    this.recompute(session);
    this.sessions.set(session.id, session);
    if (idempotencyKey !== undefined) {
      this.idempotency.set(idempotencyKey, session.id);
    }
    return session;
  }

  getSession(id: string): UcpCheckoutSession {
    return this.requireSession(id);
  }

  updateSession(id: string, body: unknown): UcpCheckoutSession {
    const session = this.requireSession(id);
    this.refuseIfTerminal(session, "update");

    const parsed = UcpUpdateCheckoutRequest.safeParse(body);
    if (!parsed.success) {
      throw new UcpError(400, "invalid_request", parsed.error.message);
    }
    const update = parsed.data;

    if (update.buyer) {
      session.buyer = { ...session.buyer, ...update.buyer };
    }

    if (update.line_items) {
      for (const change of update.line_items) {
        const target = session.line_items.find((li) => li.id === change.id);
        if (!target) {
          throw new UcpError(404, "line_item_not_found", `No line item "${change.id}"`);
        }
        if (change.quantity === 0) {
          session.line_items = session.line_items.filter((li) => li.id !== change.id);
          continue;
        }
        target.quantity = change.quantity;
      }
    }

    // Fulfillment and payment updates arrive as partial objects; the spec's
    // model is "send what changed", so selections are merged rather than
    // replacing the merchant-computed options wholesale.
    if (update.fulfillment?.methods) {
      for (const method of update.fulfillment.methods) {
        const target = session.fulfillment?.methods.find((m) => m.id === method.id);
        if (!target) continue;
        if (method.selected_destination_id !== undefined) {
          target.selected_destination_id = method.selected_destination_id;
        }
        for (const destination of method.destinations ?? []) {
          if (!target.destinations.some((d) => d.id === destination.id)) {
            target.destinations.push(destination);
          }
        }
        for (const group of method.groups ?? []) {
          const targetGroup = target.groups.find((g) => g.id === group.id);
          if (targetGroup && group.selected_option_id !== undefined) {
            targetGroup.selected_option_id = group.selected_option_id;
          }
        }
      }
    }

    if (update.payment?.instruments) {
      session.payment = { instruments: update.payment.instruments };
    }

    this.recompute(session);
    return session;
  }

  /**
   * POST /checkout-sessions/{id}/complete — the transition Vouch's mandate
   * gate sits in front of. This method deliberately does NOT know about
   * mandates: it enforces only what the spec requires, which is that a
   * session may not complete unless it has reached ready_for_complete. The
   * authority check lives one layer up, in packages/mcp-server, so that the
   * gate is a decision made *before* this call is dialled rather than a
   * condition inside it. A merchant that enforced someone else's mandate
   * would not be a faithful mock.
   */
  completeSession(id: string): UcpCheckoutSession {
    const session = this.requireSession(id);

    if (session.status === "completed") {
      return session; // Idempotent: completing twice returns the same order.
    }
    this.refuseIfTerminal(session, "complete");

    if (session.status !== "ready_for_complete") {
      throw new UcpError(
        409,
        "not_ready_for_complete",
        `Session ${id} is "${session.status}"; complete requires "ready_for_complete". ` +
          `Unmet: ${this.unmetRequirements(session).join(", ") || "unknown"}`
      );
    }

    session.status = "completed";
    session.order = {
      id: `order_${this.newId()}`,
      permalink_url: `https://mock-merchant.vouch.test/orders/${session.id}`,
    };
    session.messages = [];
    return session;
  }

  cancelSession(id: string): UcpCheckoutSession {
    const session = this.requireSession(id);
    if (session.status === "canceled") {
      return session;
    }
    if (session.status === "completed") {
      throw new UcpError(409, "already_completed", `Session ${id} is completed and cannot be canceled`);
    }
    session.status = "canceled";
    return session;
  }

  /* ---------------------------------------------------------------------
   * Internals
   * ------------------------------------------------------------------ */

  private requireSession(id: string): UcpCheckoutSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new UcpError(404, "session_not_found", `No checkout session with id "${id}"`);
    }
    return session;
  }

  private refuseIfTerminal(session: UcpCheckoutSession, verb: string): void {
    if (session.status === "completed" || session.status === "canceled") {
      throw new UcpError(
        409,
        "session_terminal",
        `Cannot ${verb} session ${session.id}: it is already "${session.status}"`
      );
    }
  }

  /**
   * What is still missing before the session may move to
   * ready_for_complete. Returned as human-readable strings because they go
   * straight into the session's `messages` array, which is what the spec
   * gives an agent to act on.
   */
  private unmetRequirements(session: UcpCheckoutSession): string[] {
    const unmet: string[] = [];

    if (session.line_items.length === 0) {
      unmet.push("at least one line item");
    }
    if (!session.buyer?.email) {
      unmet.push("buyer.email");
    }

    const method = session.fulfillment?.methods[0];
    if (!method?.selected_destination_id) {
      unmet.push("a selected fulfillment destination");
    }
    if (method && !method.groups.every((g) => g.selected_option_id !== undefined)) {
      unmet.push("a selected fulfillment option");
    }
    if (!session.payment?.instruments.some((i) => i.selected)) {
      unmet.push("a selected payment instrument");
    }

    return unmet;
  }

  /**
   * Recomputes totals and the session status after any mutation. Status is
   * derived, never assigned directly by a caller — that is what keeps
   * "ready_for_complete actually means every requirement is satisfied" true
   * rather than aspirational, and it is the property the gate depends on.
   */
  private recompute(session: UcpCheckoutSession): void {
    for (const lineItem of session.line_items) {
      const unit = lineItem.item.price ?? 0;
      lineItem.totals = [{ type: "subtotal", amount: unit * lineItem.quantity }];
    }

    const subtotal = session.line_items.reduce(
      (sum, li) => sum + (li.item.price ?? 0) * li.quantity,
      0
    );

    const method = session.fulfillment?.methods[0];
    const shipping = (method?.groups ?? []).reduce((sum, group) => {
      const selected = group.options.find((o) => o.id === group.selected_option_id);
      const total = selected?.totals.find((t) => t.type === "total");
      return sum + (total?.amount ?? 0);
    }, 0);

    const tax = Math.round(subtotal * DEMO_TAX_RATE);

    const totals: UcpTotal[] = [
      { type: "subtotal", amount: subtotal },
      { type: "shipping", amount: shipping },
      { type: "tax", amount: tax },
      { type: "total", amount: subtotal + shipping + tax },
    ];
    session.totals = totals;

    const unmet = this.unmetRequirements(session);
    session.status = unmet.length === 0 ? "ready_for_complete" : "incomplete";
    session.messages = unmet.map(
      (requirement): UcpMessage => ({
        type: "error",
        code: "missing_requirement",
        content: `Still required before complete: ${requirement}`,
        severity: "recoverable",
      })
    );
  }
}
