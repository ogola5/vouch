import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerVouchTools } from "./tools.ts";
import { notifySubscribers, registerVouchResources } from "./resources.ts";
import { handleHouseholdRequest } from "./household.ts";
import type { VouchService } from "./service.ts";
import type { HouseholdAgent } from "./householdAgent.ts";
import type { PasskeyGuard } from "./passkey.ts";
import type { Study } from "./study.ts";

/**
 * Vouch's MCP server over Streamable HTTP — the transport the Alexa+ track's
 * "Build with Agent Skills" docs point at, and the one the week-2
 * orchestrator's McpClient connects to.
 *
 * Sessions, keyed by Mcp-Session-Id (since 2026-10-14, BUILD_PLAN.md T4).
 * This was stateless until resource subscriptions needed somewhere to push
 * "the record changed". The reasoning that made stateless the first choice
 * still holds and still shapes this: all durable state is in SQLite behind
 * VouchService, never in a session, so a session holds only its transport and
 * its subscriptions — and a client that reconnects simply initializes again.
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

export function buildMcpServer(options: McpServerOptions, subscriptions: Set<string> = new Set()): McpServer {
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
  registerVouchResources(server, options.service, subscriptions);
  return server;
}

/** Sessions are cheap, but not free: a cap, and a sweep of the idle ones. */
const MAX_SESSIONS = 100;
const SESSION_IDLE_MS = 30 * 60_000;

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
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
  /*
   * SESSIONS (BUILD_PLAN.md T4 — this replaced stateless mode, deliberately).
   * A session holds only a transport and the resource URIs its client
   * subscribed to, so the server has somewhere to push "the record changed".
   * Everything durable is still in SQLite: losing a session loses a
   * subscription, never a record. The SDK client sends Mcp-Session-Id by
   * itself, so no client changed.
   */
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; lastSeen: number }>();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [, s] of sessions) if (s.lastSeen < cutoff) void s.transport.close();
  }, 60_000);
  sweep.unref();

  const httpServer = createServer((req, res) => {
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

    // An existing session: route to it (POST a message, GET the event
    // stream, DELETE to end it).
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      if (!session) {
        // Per the spec: an unknown or ended session is a 404, and the client starts a new one.
        jsonRpcError(res, 404, "Session not found — initialize a new one.");
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, req.method === "POST" ? await readJsonBody(req) : undefined);
      return;
    }

    // No session yet: only an initialize request may start one.
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    if (!isInitializeRequest(body)) {
      jsonRpcError(res, 400, "No session. Send an initialize request first.");
      return;
    }
    if (sessions.size >= MAX_SESSIONS) {
      jsonRpcError(res, 503, "Too many open sessions; try again shortly.");
      return;
    }

    const subscriptions = new Set<string>();
    const server = buildMcpServer(options, subscriptions);
    const unsubscribe = options.service.onRecordChange((change) => notifySubscribers(server, subscriptions, change));
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastSeen: Date.now() });
      },
      // DNS rebinding protection is only meaningful with a host list, and a
      // host list is only knowable by the operator, so both are opt-in
      // together. Localhost development passes neither and is unaffected.
      ...(options.allowedHosts?.length
        ? { allowedHosts: options.allowedHosts, enableDnsRebindingProtection: true }
        : {}),
      ...(options.allowedOrigins?.length ? { allowedOrigins: options.allowedOrigins } : {}),
      keepAliveMs: options.keepAliveMs ?? 25_000,
    });
    transport.onclose = () => {
      unsubscribe();
      if (transport.sessionId) sessions.delete(transport.sessionId);
      void server.close();
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  httpServer.on("close", () => {
    clearInterval(sweep);
    for (const [, s] of sessions) void s.transport.close();
  });
  return httpServer;
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
export function createHouseholdHttpServer(
  service: VouchService,
  agent?: HouseholdAgent,
  passkeys?: PasskeyGuard,
  study?: Study
): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    void handleHouseholdRequest(req, res, service, url.pathname, agent, passkeys, study)
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
  /** The household model. Its controls live on the household surface, never the agent's. */
  householdAgent?: HouseholdAgent;
  /** Passkeys for the household's widening powers. */
  passkeys?: PasskeyGuard;
  /** Study mode's answers (W5c). */
  study?: Study;
}

export function startVouchHttpServer(
  port = 0,
  options: StartOptions
): Promise<{ server: Server; householdServer: Server; url: string; householdUrl: string }> {
  const server = createVouchHttpServer(options);
  const householdServer = createHouseholdHttpServer(options.service, options.householdAgent, options.passkeys, options.study);
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
