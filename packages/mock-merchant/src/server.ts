import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { UCP_HEADERS } from "@vouch/shared";
import { Merchant, UcpError } from "./merchant.ts";

/**
 * HTTP surface for the mock merchant, implementing the UCP REST binding's
 * routes under /ucp and the /.well-known/ucp discovery document.
 *
 * Built on node:http rather than Express because the whole surface is six
 * routes and a framework would be the only runtime dependency in the
 * package. Same reasoning as node:sqlite over better-sqlite3 and node --test
 * over a test framework: the project is on Node 24 already.
 *
 * The /demo routes are NOT part of UCP. They are the price-drop control
 * surface the build plan calls for in week 2, namespaced away from /ucp so
 * that nothing in the demo rig can be mistaken for spec surface during a
 * code walkthrough.
 */

const SESSION_PATH = /^\/ucp\/checkout-sessions\/([^/]+)$/;
const SESSION_ACTION_PATH = /^\/ucp\/checkout-sessions\/([^/]+)\/(complete|cancel)$/;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new UcpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * The spec requires UCP-Agent on checkout requests, carrying the calling
 * agent's profile URL. Enforced rather than ignored because it is the one
 * place the merchant can see *which* agent is asking — the natural seam for
 * a future real Alexa+ integration to identify itself, and worth having the
 * mock prove is wired rather than assumed.
 */
function requireAgentHeader(req: IncomingMessage): void {
  const agent = req.headers[UCP_HEADERS.agent.toLowerCase()];
  if (typeof agent !== "string" || !agent.includes("profile=")) {
    throw new UcpError(
      400,
      "missing_ucp_agent",
      `${UCP_HEADERS.agent} header is required and must carry profile="<url>"`
    );
  }
}

export interface MerchantServerOptions {
  merchant?: Merchant;
  /** Used to build the endpoint URL in the discovery document. */
  baseUrl?: string;
}

export function createMerchantServer(options: MerchantServerOptions = {}): {
  server: Server;
  merchant: Merchant;
} {
  const merchant = options.merchant ?? new Merchant();

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof UcpError) {
        send(res, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      send(res, 500, { error: { code: "internal_error", message } });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";
    const baseUrl = options.baseUrl ?? `http://${req.headers.host ?? "localhost"}`;

    if (method === "GET" && path === "/.well-known/ucp") {
      send(res, 200, merchant.profile(baseUrl));
      return;
    }

    if (method === "POST" && path === "/ucp/checkout-sessions") {
      requireAgentHeader(req);
      const idempotencyKey = req.headers[UCP_HEADERS.idempotencyKey.toLowerCase()];
      const session = merchant.createSession(
        await readJsonBody(req),
        typeof idempotencyKey === "string" ? idempotencyKey : undefined
      );
      send(res, 201, session);
      return;
    }

    const actionMatch = SESSION_ACTION_PATH.exec(path);
    if (actionMatch && method === "POST") {
      requireAgentHeader(req);
      const [, id, action] = actionMatch;
      const session =
        action === "complete" ? merchant.completeSession(id!) : merchant.cancelSession(id!);
      send(res, 200, session);
      return;
    }

    const sessionMatch = SESSION_PATH.exec(path);
    if (sessionMatch) {
      const id = sessionMatch[1]!;
      if (method === "GET") {
        send(res, 200, merchant.getSession(id));
        return;
      }
      if (method === "PUT") {
        requireAgentHeader(req);
        send(res, 200, merchant.updateSession(id, await readJsonBody(req)));
        return;
      }
    }

    /*
     * The product listing. NOT under /demo, and not under /ucp either, and
     * the distinction is deliberate.
     *
     * Not /demo, because a real agent reads this to find out what exists —
     * it is part of the merchant's actual surface, unlike the price lever
     * below, which is a rig for driving the demo.
     *
     * Not /ucp, because we have not earned that prefix here. packages/shared
     * implements the checkout REST binding against a verified snapshot; UCP's
     * catalog surface lives in its MCP binding (`search_catalog`), which we
     * have not implemented. Putting an invented route under /ucp would imply
     * a spec conformance we did not check — which is exactly the mistake the
     * ucp.ts rewrite was written to stop repeating.
     */
    if (method === "GET" && path === "/catalog") {
      const query = url.searchParams.get("q")?.trim().toLowerCase();
      const products = merchant.catalog.list();
      send(res, 200, {
        products: query
          ? products.filter((p) =>
              `${p.id} ${p.title} ${p.brand}`.toLowerCase().includes(query)
            )
          : products,
      });
      return;
    }

    // Demo control surface — not UCP, and not part of the merchant's real
    // surface either. This is the lever that makes a price change happen.

    if (method === "POST" && path === "/demo/price") {
      const body = (await readJsonBody(req)) as { product_id?: string; price?: number };
      if (typeof body.product_id !== "string" || typeof body.price !== "number") {
        throw new UcpError(400, "invalid_request", `Expected { product_id: string, price: number }`);
      }
      send(res, 200, { product: merchant.catalog.setPriceMajor(body.product_id, body.price) });
      return;
    }

    send(res, 404, { error: { code: "not_found", message: `No route for ${method} ${path}` } });
  }

  return { server, merchant };
}

/** Starts the server on `port` and resolves with its actual address. */
export function startMerchantServer(
  port = 0,
  options: MerchantServerOptions = {}
): Promise<{ server: Server; merchant: Merchant; url: string }> {
  const { server, merchant } = createMerchantServer(options);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({ server, merchant, url: `http://127.0.0.1:${actualPort}` });
    });
  });
}
