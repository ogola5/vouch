import { randomUUID } from "node:crypto";
import {
  UCP_HEADERS,
  ucpAgentHeader,
  UcpCheckoutSession,
  type UcpCreateCheckoutRequest,
  type UcpUpdateCheckoutRequest,
} from "@vouch/shared";

/**
 * The MCP server's view of a UCP merchant.
 *
 * This is an interface, not a concrete class, for one specific reason: it is
 * what makes "an out-of-bounds proposal never reaches Complete" a testable
 * claim rather than an assertion in a README. A test can pass a recording
 * implementation and assert `completeSession` was never called — see
 * packages/mcp-server/test/gate-before-complete.test.ts. The production
 * composition root passes HttpMerchantClient, which really does cross a
 * network boundary to packages/mock-merchant.
 */
/**
 * A product as the merchant lists it. Price is in ISO 4217 MINOR units here,
 * like everything else crossing this boundary; conversion to the major units
 * a human (or a model) reads happens one layer up, in VouchService.
 */
export interface MerchantProduct {
  id: string;
  title: string;
  brand: string;
  price: number;
  currency: string;
}

export interface MerchantClient {
  createSession(request: UcpCreateCheckoutRequest): Promise<UcpCheckoutSession>;
  updateSession(id: string, request: UcpUpdateCheckoutRequest): Promise<UcpCheckoutSession>;
  completeSession(id: string): Promise<UcpCheckoutSession>;
  cancelSession(id: string): Promise<UcpCheckoutSession>;
  /**
   * Added after the first live agent run, which found the gap the hard way:
   * asked to restock Brand A, the model invented the product id
   * "brand-a-detergent" (the real one is "detergent-brand-a") and the
   * purchase failed. An agent that cannot see what exists cannot buy
   * anything, and — worse — falls back to answering from its own judgement
   * instead of calling the gate. See BUILD_PLAN.md §7.
   */
  listProducts(query?: string): Promise<MerchantProduct[]>;
}

export class MerchantRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MerchantRequestError";
    this.status = status;
  }
}

/**
 * The agent profile URL sent in the UCP-Agent header. A real Alexa+
 * integration would publish a profile document here; the mock merchant only
 * checks the header is present and well-formed, but sending a truthful
 * placeholder beats sending a plausible-looking lie about being Amazon.
 */
export const VOUCH_AGENT_PROFILE = "https://vouch.test/agent-profile";

/**
 * Fields are assigned in the constructor body rather than declared as
 * parameter properties: Node 24's strip-only type stripping rejects
 * `constructor(private x: T)` outright, and this file is loaded directly by
 * `npm run dev:mcp-server` and by the tests.
 */
export class HttpMerchantClient implements MerchantClient {
  private readonly baseUrl: string;
  private readonly agentProfile: string;

  constructor(baseUrl: string, agentProfile: string = VOUCH_AGENT_PROFILE) {
    this.baseUrl = baseUrl;
    this.agentProfile = agentProfile;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<UcpCheckoutSession> {
    const headers: Record<string, string> = {
      [UCP_HEADERS.contentType]: "application/json",
      [UCP_HEADERS.agent]: ucpAgentHeader(this.agentProfile),
      [UCP_HEADERS.requestId]: randomUUID(),
    };
    if (idempotencyKey !== undefined) {
      headers[UCP_HEADERS.idempotencyKey] = idempotencyKey;
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new MerchantRequestError(response.status, `${method} ${path} -> ${response.status}: ${text}`);
    }

    // Parsed, not cast: a merchant that drifts from the spec should fail
    // here, loudly, rather than downstream in the gate with a confusing
    // undefined price.
    return UcpCheckoutSession.parse(JSON.parse(text));
  }

  createSession(request: UcpCreateCheckoutRequest): Promise<UcpCheckoutSession> {
    return this.request("POST", "/ucp/checkout-sessions", request, randomUUID());
  }

  updateSession(id: string, request: UcpUpdateCheckoutRequest): Promise<UcpCheckoutSession> {
    return this.request("PUT", `/ucp/checkout-sessions/${encodeURIComponent(id)}`, request);
  }

  completeSession(id: string): Promise<UcpCheckoutSession> {
    return this.request("POST", `/ucp/checkout-sessions/${encodeURIComponent(id)}/complete`);
  }

  cancelSession(id: string): Promise<UcpCheckoutSession> {
    return this.request("POST", `/ucp/checkout-sessions/${encodeURIComponent(id)}/cancel`);
  }

  async listProducts(query?: string): Promise<MerchantProduct[]> {
    const suffix = query ? `?q=${encodeURIComponent(query)}` : "";
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/catalog${suffix}`, {
      headers: { [UCP_HEADERS.requestId]: randomUUID() },
    });
    if (!response.ok) {
      throw new MerchantRequestError(
        response.status,
        `GET /catalog -> ${response.status}: ${await response.text()}`
      );
    }
    const body = (await response.json()) as { products?: MerchantProduct[] };
    return body.products ?? [];
  }
}
