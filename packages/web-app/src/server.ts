import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { MerchantDemoClient, VouchBridge } from "./bridge.ts";
import { ChatSession } from "./chat.ts";

/**
 * The web app's HTTP surface: a handful of JSON endpoints for the page, plus
 * the page itself.
 *
 * node:http and a static HTML file rather than Next/Vite/React, for the same
 * reason the rest of the project has almost no dependencies: this is a
 * dashboard over an API that already exists, and a build step is one more
 * thing that can fail while a demo is being recorded. There is no bundler, so
 * there is no bundler to break at 2am.
 */

const PAGE_URL = new URL("../public/index.html", import.meta.url);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export interface WebAppOptions {
  mcpUrl: string;
  merchantUrl: string;
}

export function createWebApp(options: WebAppOptions): {
  server: Server;
  bridge: VouchBridge;
  chat: ChatSession;
} {
  const bridge = new VouchBridge(options.mcpUrl);
  const merchant = new MerchantDemoClient(options.merchantUrl);
  const chat = new ChatSession(options.mcpUrl);

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      const html = await readFile(PAGE_URL, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }

    /*
     * Everything the dashboard renders, in one round trip. Deliberately built
     * from the same MCP tools an agent would call — list_mandates and
     * list_vouches — rather than reading the SQLite file directly. Reading the
     * database would be easier and would quietly make the page a second source
     * of truth that could disagree with the server; going through the tools
     * means what you see is exactly what an agent sees.
     */
    if (method === "GET" && path === "/api/state") {
      await bridge.connect();
      const [mandates, vouches, catalog] = await Promise.all([
        bridge.callJson<unknown[]>("list_mandates"),
        bridge.callJson<unknown[]>("list_vouches", { limit: 50 }),
        merchant.catalog(),
      ]);
      sendJson(res, 200, { mandates, vouches, catalog: catalog.products, ok: true });
      return;
    }

    if (method === "GET" && path === "/api/health") {
      await bridge.connect();
      sendJson(res, 200, {
        ok: true,
        tools: await bridge.listToolNames(),
        chat: chat.status(),
      });
      return;
    }

    /*
     * The conversation. Reported as a 503 rather than a 500 when the model is
     * unconfigured, because the console is not broken in that case — the gate,
     * the record and every control below still work. The page says so and
     * stays usable, which is the whole reason the agent is built lazily.
     */
    if (method === "POST" && path === "/api/chat") {
      const body = await readJsonBody(req);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        sendJson(res, 400, { error: "Say something first." });
        return;
      }
      if (chat.status().status === "unconfigured") {
        sendJson(res, 503, { error: chat.status().detail });
        return;
      }
      try {
        sendJson(res, 200, await chat.send(message));
      } catch (error) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // Generic MCP tool proxy. The page names the tool; this process does not
    // whitelist or reshape, because the MCP server's own tool surface is
    // already the security boundary — there is no tool that completes a
    // checkout without passing the gate, so exposing them all is safe by
    // construction rather than by a list kept in sync here.
    if (method === "POST" && path.startsWith("/api/tool/")) {
      const name = decodeURIComponent(path.slice("/api/tool/".length));
      await bridge.connect();
      const { text, isError } = await bridge.callTool(name, await readJsonBody(req));
      sendJson(res, isError ? 400 : 200, { ok: !isError, text });
      return;
    }

    /*
     * The household surface, proxied straight through to mcp-server's
     * /household routes. These are the powers the AGENT does not have —
     * approving a held purchase, editing a mandate's limits — so they
     * deliberately do NOT go through the MCP tool proxy above. If they did,
     * they would be tools, and a tool is something a model can call.
     */
    if (path.startsWith("/api/household/")) {
      const target = `${options.mcpUrl.replace(/\/mcp$/, "")}/household/${path.slice("/api/household/".length)}`;
      const response = await fetch(target, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(await readJsonBody(req)),
      });
      sendJson(res, response.status, await response.json());
      return;
    }

    if (method === "POST" && path === "/api/price") {
      const body = await readJsonBody(req);
      const productId = body.product_id;
      const price = Number(body.price);
      if (typeof productId !== "string" || !Number.isFinite(price)) {
        sendJson(res, 400, { error: "Expected { product_id: string, price: number }" });
        return;
      }
      sendJson(res, 200, await merchant.setPrice(productId, price));
      return;
    }

    sendJson(res, 404, { error: `No route for ${method} ${path}` });
  }

  return { server, bridge, chat };
}

export function startWebApp(
  port: number,
  options: WebAppOptions
): Promise<{ server: Server; bridge: VouchBridge; chat: ChatSession; url: string }> {
  const { server, bridge, chat } = createWebApp(options);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({ server, bridge, chat, url: `http://127.0.0.1:${actualPort}` });
    });
  });
}
