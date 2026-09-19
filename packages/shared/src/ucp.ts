import { z } from "zod";

/**
 * UCP (Universal Commerce Protocol) checkout types.
 *
 * These are written against the published specification at
 * https://ucp.dev/specification/checkout-rest/ (REST binding, snapshot
 * version "2026-04-08"), not from the brief's prose description. The
 * earlier PROVISIONAL version of this file guessed at the shape and got
 * most of it wrong — session_id vs. id, a created/updated/complete/
 * cancelled status enum that doesn't exist, decimal prices instead of
 * minor units, a singular payment_handler. Anything reading this file
 * should treat the ucp.dev spec as the source of truth and fix this file
 * when they disagree, rather than the other way round.
 *
 * ATTRIBUTION, because the brief gets this wrong and the submission
 * writeup must not: UCP is an open standard, not an Amazon spec. It was
 * founded by Google, Shopify, Etsy, Target and Wayfair; Amazon, Meta,
 * Microsoft, Salesforce and Stripe joined the UCP Tech Council in April
 * 2026. The accurate framing for Vouch is "a trust layer built on the
 * open standard Amazon recently joined the governance council for", not
 * "a reference implementation of Amazon's own spec".
 *
 * Not yet modelled here, because packages/mock-merchant doesn't need them
 * to demonstrate the gate: HTTP Message Signatures (RFC 9421 —
 * Signature-Input / Signature / Content-Digest headers) and the JWK key
 * set published in the profile. Both are noted inline below.
 */

/* -------------------------------------------------------------------------
 * Money
 * ---------------------------------------------------------------------- */

/**
 * A monetary amount in the currency's MINOR unit, per ISO 4217 — 2500 is
 * $25.00, not $2500. This is the most consequential difference between
 * this file and the shape it replaced, because a mandate's `max_price` is
 * authored by a human in major units ("keep detergent stocked under $15").
 * Comparing a UCP amount against a mandate constraint without converting
 * is a 100x error. It fails closed rather than open — every price looks
 * huge, so every purchase gets held for approval — which means it will
 * present as "the gate is broken and blocks everything" rather than as a
 * security hole. Convert at the boundary with toMajorUnits() before
 * calling evaluateProposal(); see gate.ts's PurchaseProposal.
 */
export const UcpAmount = z.number().int();
export type UcpAmount = z.infer<typeof UcpAmount>;

/** ISO 4217 minor-unit exponents for the currencies the demo uses. */
export const CURRENCY_EXPONENTS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
};

function exponentFor(currency: string): number {
  const exponent = CURRENCY_EXPONENTS[currency.toUpperCase()];
  if (exponent === undefined) {
    throw new Error(
      `Unknown ISO 4217 exponent for currency "${currency}" — add it to CURRENCY_EXPONENTS ` +
        `rather than assuming 2, so an unfamiliar currency can never silently mis-scale a price.`
    );
  }
  return exponent;
}

/** 2500, "USD" -> 25. Use this before comparing a UCP price to a mandate. */
export function toMajorUnits(amount: UcpAmount, currency: string): number {
  return amount / 10 ** exponentFor(currency);
}

/** 25, "USD" -> 2500. Use this when building a UCP request from a mandate. */
export function toMinorUnits(major: number, currency: string): UcpAmount {
  return Math.round(major * 10 ** exponentFor(currency));
}

/* -------------------------------------------------------------------------
 * Core objects
 * ---------------------------------------------------------------------- */

/**
 * Note `ready_for_complete`: the spec has a distinct state meaning "every
 * requirement is satisfied but the order has NOT been placed". That is
 * exactly where Vouch's mandate gate belongs — the transition
 * ready_for_complete -> completed is the one the MCP server must refuse
 * to make for an out-of-bounds proposal. See packages/shared/src/gate.ts.
 */
export const UcpCheckoutStatus = z.enum([
  "incomplete",
  "ready_for_complete",
  "completed",
  "canceled", // US spelling, per spec — not "cancelled"
]);
export type UcpCheckoutStatus = z.infer<typeof UcpCheckoutStatus>;

/**
 * Known `type` values observed in the spec's examples are "subtotal",
 * "tax" and "total"; shipping options also carry a "total". Left as a
 * string rather than an enum until the OpenAPI schema
 * (https://ucp.dev/draft/services/shopping/rest.openapi.json) is read and
 * the closed set confirmed — guessing a closed enum here would reintroduce
 * exactly the failure this rewrite is fixing.
 */
export const UcpTotal = z.object({
  type: z.string(),
  amount: UcpAmount,
});
export type UcpTotal = z.infer<typeof UcpTotal>;

export const UcpItem = z.object({
  id: z.string(),
  title: z.string().optional(),
  price: UcpAmount.optional(),
  quantity_unit: z.record(z.unknown()).optional(),
});
export type UcpItem = z.infer<typeof UcpItem>;

export const UcpLineItem = z.object({
  id: z.string(),
  item: UcpItem,
  quantity: z.number().int().positive(),
  totals: z.array(UcpTotal).default([]),
});
export type UcpLineItem = z.infer<typeof UcpLineItem>;

export const UcpBuyer = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().email().optional(),
  phone_number: z.string().optional(),
});
export type UcpBuyer = z.infer<typeof UcpBuyer>;

export const UcpLink = z.object({
  type: z.string(),
  url: z.string().url(),
});
export type UcpLink = z.infer<typeof UcpLink>;

export const UcpOrder = z.object({
  id: z.string(),
  permalink_url: z.string().url().optional(),
});
export type UcpOrder = z.infer<typeof UcpOrder>;

/* -------------------------------------------------------------------------
 * Fulfillment
 * ---------------------------------------------------------------------- */

export const UcpDestination = z.object({
  id: z.string(),
  street_address: z.string().optional(),
  address_locality: z.string().optional(),
  address_region: z.string().optional(),
  postal_code: z.string().optional(),
  address_country: z.string().optional(),
});
export type UcpDestination = z.infer<typeof UcpDestination>;

export const UcpFulfillmentOption = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  totals: z.array(UcpTotal).default([]),
});
export type UcpFulfillmentOption = z.infer<typeof UcpFulfillmentOption>;

export const UcpFulfillmentGroup = z.object({
  id: z.string(),
  line_item_ids: z.array(z.string()),
  selected_option_id: z.string().optional(),
  options: z.array(UcpFulfillmentOption).default([]),
});
export type UcpFulfillmentGroup = z.infer<typeof UcpFulfillmentGroup>;

export const UcpFulfillmentMethod = z.object({
  id: z.string(),
  type: z.string(), // e.g. "shipping"
  line_item_ids: z.array(z.string()),
  selected_destination_id: z.string().optional(),
  destinations: z.array(UcpDestination).default([]),
  groups: z.array(UcpFulfillmentGroup).default([]),
});
export type UcpFulfillmentMethod = z.infer<typeof UcpFulfillmentMethod>;

export const UcpFulfillment = z.object({
  methods: z.array(UcpFulfillmentMethod).default([]),
  available_methods: z.array(UcpFulfillmentMethod).optional(),
});
export type UcpFulfillment = z.infer<typeof UcpFulfillment>;

/* -------------------------------------------------------------------------
 * Payment
 * ---------------------------------------------------------------------- */

/**
 * Handlers are declared in the `ucp` envelope (and in the /.well-known/ucp
 * profile) keyed by a reverse-DNS name such as "com.shopify.shop_pay" or
 * "com.google.pay". The brief's "Network Token / Stored Payment Method"
 * wording describes instrument *types*, not this handler structure.
 */
export const UcpPaymentHandler = z.object({
  id: z.string(),
  version: z.string(),
  available_instruments: z.array(z.object({ type: z.string() })).default([]),
  config: z.record(z.unknown()).optional(),
});
export type UcpPaymentHandler = z.infer<typeof UcpPaymentHandler>;

export const UcpPaymentInstrument = z.object({
  id: z.string(),
  handler_id: z.string(),
  type: z.string(),
  selected: z.boolean().optional(),
  credential: z.record(z.unknown()).optional(),
  display: z.record(z.unknown()).optional(),
});
export type UcpPaymentInstrument = z.infer<typeof UcpPaymentInstrument>;

export const UcpPayment = z.object({
  instruments: z.array(UcpPaymentInstrument).default([]),
});
export type UcpPayment = z.infer<typeof UcpPayment>;

/* -------------------------------------------------------------------------
 * Messages
 * ---------------------------------------------------------------------- */

export const UcpMessage = z.object({
  type: z.enum(["error", "warning", "info"]),
  code: z.string(),
  path: z.string().optional(), // JSONPath, e.g. "$.buyer.email"
  content: z.string(),
  severity: z.string().optional(), // e.g. "recoverable"
});
export type UcpMessage = z.infer<typeof UcpMessage>;

/* -------------------------------------------------------------------------
 * Protocol envelope, checkout session, requests
 * ---------------------------------------------------------------------- */

export const UcpCapabilityDeclaration = z.object({
  version: z.string(),
  schema: z.string().url().optional(),
  extends: z.string().optional(),
});
export type UcpCapabilityDeclaration = z.infer<typeof UcpCapabilityDeclaration>;

/** The `ucp` object carried on every response body. */
export const UcpEnvelope = z.object({
  version: z.string(),
  capabilities: z.record(z.array(UcpCapabilityDeclaration)).default({}),
  payment_handlers: z.record(z.array(UcpPaymentHandler)).optional(),
});
export type UcpEnvelope = z.infer<typeof UcpEnvelope>;

export const UcpCheckoutSession = z.object({
  ucp: UcpEnvelope,
  id: z.string(),
  status: UcpCheckoutStatus,
  currency: z.string(),
  order: UcpOrder.optional(),
  line_items: z.array(UcpLineItem).default([]),
  buyer: UcpBuyer.optional(),
  totals: z.array(UcpTotal).default([]),
  links: z.array(UcpLink).optional(),
  fulfillment: UcpFulfillment.optional(),
  payment: UcpPayment.optional(),
  messages: z.array(UcpMessage).optional(),
});
export type UcpCheckoutSession = z.infer<typeof UcpCheckoutSession>;

/**
 * POST /checkout-sessions — the create body is deliberately minimal in the
 * spec: an item reference and a quantity. Everything else (totals, tax,
 * fulfillment options) is computed by the business and returned.
 */
export const UcpCreateCheckoutRequest = z.object({
  line_items: z
    .array(
      z.object({
        item: z.object({ id: z.string() }),
        quantity: z.number().int().positive(),
      })
    )
    .min(1),
  buyer: UcpBuyer.optional(),
  currency: z.string().optional(),
});
export type UcpCreateCheckoutRequest = z.infer<typeof UcpCreateCheckoutRequest>;

/** PUT /checkout-sessions/{id} — every field optional; send what changed. */
export const UcpUpdateCheckoutRequest = z.object({
  line_items: z.array(z.object({ id: z.string(), quantity: z.number().int().nonnegative() })).optional(),
  buyer: UcpBuyer.optional(),
  fulfillment: UcpFulfillment.partial().optional(),
  payment: UcpPayment.partial().optional(),
});
export type UcpUpdateCheckoutRequest = z.infer<typeof UcpUpdateCheckoutRequest>;

/* -------------------------------------------------------------------------
 * Transport
 * ---------------------------------------------------------------------- */

/** REST binding routes, relative to the endpoint found in the profile. */
export const UCP_CHECKOUT_ROUTES = {
  create: { method: "POST", path: "/checkout-sessions" },
  get: { method: "GET", path: "/checkout-sessions/{id}" },
  update: { method: "PUT", path: "/checkout-sessions/{id}" },
  complete: { method: "POST", path: "/checkout-sessions/{id}/complete" },
  cancel: { method: "POST", path: "/checkout-sessions/{id}/cancel" },
} as const;

/**
 * Required request headers. `UCP-Agent` carries the calling agent's
 * profile URL as `profile="https://platform.example/profile"` — which is
 * worth noticing, because it means the merchant can see *which agent*
 * asked, and is the natural place for a future real Alexa+ integration to
 * identify itself. Signing headers (Signature-Input, Signature,
 * Content-Digest, per RFC 9421) are recommended but not modelled yet.
 */
export const UCP_HEADERS = {
  agent: "UCP-Agent",
  idempotencyKey: "Idempotency-Key",
  requestId: "Request-Id",
  contentType: "Content-Type",
} as const;

/** Formats the UCP-Agent header value for a given agent profile URL. */
export function ucpAgentHeader(profileUrl: string): string {
  return `profile="${profileUrl}"`;
}

/* -------------------------------------------------------------------------
 * Discovery: /.well-known/ucp
 * ---------------------------------------------------------------------- */

/**
 * A business declares its transports here. Note the "mcp" transport: UCP
 * has its own MCP binding whose tool names are fixed by the spec
 * (search_catalog, create_cart, create_checkout, complete_checkout,
 * get_order, ...). Those are the *merchant's* tools and are distinct from
 * Vouch's own MCP tools (create_mandate, propose_purchase, ...), which are
 * the household trust layer sitting in front of them.
 */
export const UcpServiceBinding = z.object({
  version: z.string(),
  transport: z.enum(["rest", "mcp", "a2a"]),
  schema: z.string().url().optional(),
  endpoint: z.string().url(),
});
export type UcpServiceBinding = z.infer<typeof UcpServiceBinding>;

export const UcpProfile = z.object({
  ucp: z.object({
    version: z.string(),
    services: z.record(z.array(UcpServiceBinding)).default({}),
    capabilities: z.record(z.array(UcpCapabilityDeclaration)).default({}),
    payment_handlers: z.record(z.array(UcpPaymentHandler)).optional(),
  }),
  /** RFC 7517 JWK Set for signature verification. Not used by the mock yet. */
  keys: z.array(z.record(z.unknown())).optional(),
});
export type UcpProfile = z.infer<typeof UcpProfile>;

/** The spec version packages/mock-merchant implements. */
export const UCP_VERSION = "2026-04-08";

/** Reverse-DNS capability key for the checkout capability. */
export const UCP_CHECKOUT_CAPABILITY = "dev.ucp.shopping.checkout";
