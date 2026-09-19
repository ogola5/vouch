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

    // The household's surface, which holds the powers the agent must not
    // have (approve a held purchase, edit a mandate's limits). See
    // household.ts for why it is a separate surface rather than a flag.
    if (await handleHouseholdRequest(req, res, options.service, url.pathname)) {
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `No route for ${req.method} ${url.pathname}` }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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

export function startVouchHttpServer(
  port = 0,
  options: McpServerOptions
): Promise<{ server: Server; url: string }> {
  const server = createVouchHttpServer(options);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({ server, url: `http://127.0.0.1:${actualPort}` });
    });
  });
}
