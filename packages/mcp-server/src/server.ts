import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerVouchTools } from "./tools.ts";
import { handleHouseholdRequest } from "./household.ts";
import type { VouchService } from "./service.ts";

/**
 * Vouch's MCP server over Streamable HTTP — the transport the Alexa+ track's
 * "Build with Agent Skills" docs point at, and the one the week-2
 * orchestrator's McpClient connects to.
 *
 * Stateless mode (`sessionIdGenerator: undefined`): a fresh transport and
 * McpServer per request, torn down when the response closes. The alternative
 * — long-lived sessions keyed by Mcp-Session-Id — buys resumability that
 * this project has no use for, since all durable state is in SQLite behind
 * VouchService rather than in transport memory. Statelessness also means a
 * demo recording survives a client reconnect, which is worth more here than
 * stream resumption.
 */

export interface McpServerOptions {
  service: VouchService;
  /** Overridable for tests that want to assert on the advertised metadata. */
  serverInfo?: { name: string; version: string };
  /**
   * Host header values this server will answer to. Required once the server
   * is reachable from anywhere but localhost — see `createVouchHttpServer`.
   */
  allowedHosts?: string[];
  /** Origins permitted to call it from a browser. */
  allowedOrigins?: string[];
  /**
   * Keep-alive ping interval for the SSE stream, in ms.
   *
   * Tunnels and load balancers close idle connections, typically well inside
   * a minute. Without a ping, a long tool call can lose its stream mid-answer
   * and present as the agent silently giving up.
   */
  keepAliveMs?: number;
}

export function buildMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer(
    options.serverInfo ?? { name: "vouch", version: "0.0.0" },
    {
      instructions:
        "Vouch is the household's trust layer over an agent's autonomous purchases. Every " +
        "purchase must go through propose_purchase, which checks the relevant mandate before " +
        "an order is placed and records a Vouch either way. If a proposal comes back " +
        "held_for_approval, do not try to buy it another way — tell the household what stopped " +
        "it (explain_vouch) and wait for them to approve.",
    }
  );
  registerVouchTools(server, options.service);
  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createVouchHttpServer(options: McpServerOptions): Server {
  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message },
          id: null,
        })
      );
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    /*
     * NO HOUSEHOLD ROUTES HERE. They used to be served by this listener, and
     * moving them out is the point.
     *
     * This server has to be publicly reachable for the Alexa+ bridge — a
     * tunnel in front of /mcp. The household surface can approve held
     * purchases and raise mandate limits, and it has no authentication. On
     * the same listener, tunnelling /mcp would have published the household's
     * authority to the internet, where anyone with the URL could approve the
     * purchases the gate had just refused.
     *
     * It now lives on its own listener, bound to loopback, in
     * createHouseholdHttpServer below. Structural rather than a check: a port
     * that never leaves the machine cannot be forwarded by accident, whereas
     * a path filter is one refactor away from being wrong.
     */
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `No route for ${req.method} ${url.pathname}` }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // DNS rebinding protection is only meaningful with a host list, and a
      // host list is only knowable by the operator, so both are opt-in
      // together. Localhost development passes neither and is unaffected.
      ...(options.allowedHosts?.length
        ? { allowedHosts: options.allowedHosts, enableDnsRebindingProtection: true }
        : {}),
      ...(options.allowedOrigins?.length ? { allowedOrigins: options.allowedOrigins } : {}),
      keepAliveMs: options.keepAliveMs ?? 25_000,
    });
    const server = buildMcpServer(options);

    // Both are per-request in stateless mode, so they have to be released
    // when the response finishes or a long-running demo leaks one McpServer
    // per tool call.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, await readJsonBody(req));
  }
}

/**
 * The household's surface, on its own listener.
 *
 * Separate from the MCP server so it can be bound to loopback while /mcp is
 * exposed through a tunnel. The powers here — approving a held purchase,
 * raising a mandate's limits — are the ones the agent is deliberately denied,
 * and there is no authentication on them yet. Keeping them on a port that
 * never leaves the machine is what makes that acceptable; see household.ts.
 */
export function createHouseholdHttpServer(service: VouchService): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    void handleHouseholdRequest(req, res, service, url.pathname)
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `No household route for ${req.method} ${url.pathname}` }));
        }
      })
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal_error" }));
        }
      });
  });
}

export interface StartOptions extends McpServerOptions {
  /**
   * Interface the MCP server binds to. Loopback by default; a tunnel or
   * container needs 0.0.0.0, and that is the moment allowedHosts starts
   * mattering.
   */
  host?: string;
  /** Port for the loopback-only household surface. */
  householdPort?: number;
}

export function startVouchHttpServer(
  port = 0,
  options: StartOptions
): Promise<{ server: Server; householdServer: Server; url: string; householdUrl: string }> {
  const server = createVouchHttpServer(options);
  const householdServer = createHouseholdHttpServer(options.service);
  const host = options.host ?? "127.0.0.1";

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;

      // Always loopback, whatever `host` says. Passing 0.0.0.0 to expose the
      // MCP server must never widen this one too — that coupling is exactly
      // the accident this split exists to prevent.
      householdServer.listen(options.householdPort ?? 0, "127.0.0.1", () => {
        const hh = householdServer.address();
        const householdPort = typeof hh === "object" && hh ? hh.port : 0;
        resolve({
          server,
          householdServer,
          url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actualPort}`,
          householdUrl: `http://127.0.0.1:${householdPort}`,
        });
      });
    });
  });
}
