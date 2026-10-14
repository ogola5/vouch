import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * A browser cannot speak MCP usefully — MCP is JSON-RPC with a session
 * lifecycle, and putting that in front-end code would mean reimplementing a
 * protocol client to render a table. So this process holds ONE MCP client
 * and exposes a small REST surface to the page.
 *
 * That shape is not a shortcut around the architecture, it IS the
 * architecture: BUILD_PLAN.md §2 describes "an orchestrator running
 * server-side inside web-app, holding an MCP client connected to
 * packages/mcp-server's Streamable HTTP endpoint". This is that process with
 * the model left out. When the Strands agent arrives it slots in here, beside
 * this client, rather than replacing it.
 *
 * What this bridge deliberately does NOT do is decide anything. It has no
 * business logic, no gate, no fallback that "fixes up" a held purchase. Every
 * answer it gives the page came from an MCP tool call. If it started making
 * decisions, the dashboard would stop being evidence of what the server does
 * and start being a second implementation that could disagree with it.
 */

export interface ToolTextResult {
  text: string;
  isError: boolean;
}

/** The record resource every change touches (mcp-server resources.ts). */
const WAITING_URI = "vouch://records/waiting";

/**
 * True when our session is gone: the server forgot it (restarted, or swept
 * us as idle — a 404, per the spec), or the connection it lived on was
 * dropped. Either way the answer is a new session. Found by the restart test:
 * the first error after a restart is usually the dropped socket, not the 404.
 */
export function isSessionLost(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /session not found|\b404\b|fetch failed|other side closed|ECONNRESET|socket hang up/i.test(text);
}

export class VouchBridge {
  private client: Client;
  private readonly mcpUrl: string;
  private connected = false;
  private readonly recordListeners = new Set<() => void>();

  constructor(mcpUrl: string) {
    this.mcpUrl = mcpUrl;
    this.client = new Client({ name: "vouch-web-app", version: "0.0.0" });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl)));
    this.connected = true;
    /*
     * T4: subscribe to what is waiting for the household. Every change to the
     * record touches it, so the console hears about purchases it did not
     * start — an outside agent's, the household agent's — and can show them
     * at once. Best-effort: a server without subscriptions still works.
     */
    this.client.setNotificationHandler(ResourceUpdatedNotificationSchema, async () => {
      for (const listener of this.recordListeners) listener();
    });
    await this.client.subscribeResource({ uri: WAITING_URI }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  /** Called whenever the record changes on the server; returns an unsubscribe. */
  onRecordChanged(listener: () => void): () => void {
    this.recordListeners.add(listener);
    return () => this.recordListeners.delete(listener);
  }

  /**
   * Runs `call`, and if the server has forgotten our session (it restarted),
   * starts a new one and tries once more. Stateless mode never needed this;
   * sessions (T4) do.
   */
  private async withSession<T>(call: () => Promise<T>): Promise<T> {
    await this.connect();
    try {
      return await call();
    } catch (error) {
      if (!isSessionLost(error)) throw error;
      await this.client.close().catch(() => undefined);
      this.client = new Client({ name: "vouch-web-app", version: "0.0.0" });
      this.connected = false;
      await this.connect();
      return call();
    }
  }

  async listToolNames(): Promise<string[]> {
    const { tools } = await this.withSession(() => this.client.listTools());
    return tools.map((t) => t.name);
  }

  /** Raw call — text content joined, with the tool's own error flag preserved. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolTextResult> {
    const result = await this.withSession(() => this.client.callTool({ name, arguments: args }));
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    return { text, isError: result.isError === true };
  }

  /**
   * Calls a tool whose result is JSON. Throws on a tool error rather than
   * returning a half-parsed object, so a failure surfaces in the page as a
   * failure instead of an empty table.
   */
  async callJson<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const { text, isError } = await this.callTool(name, args);
    if (isError) {
      throw new Error(text || `${name} failed`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${name} did not return JSON: ${text.slice(0, 200)}`);
    }
  }
}

/**
 * The merchant's /demo routes are NOT UCP and NOT MCP — they are the
 * price-drop lever from BUILD_PLAN.md §2, deliberately namespaced away from
 * /ucp so nothing in the demo rig can be mistaken for spec surface. The page
 * reaches them through here rather than calling the merchant directly,
 * so the browser only ever talks to one origin.
 */
export class MerchantDemoClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async catalog(): Promise<{ products: unknown[] }> {
    // /catalog, not /demo/catalog: the listing is part of the merchant's real
    // surface (an agent reads it to find products), while /demo/price below
    // is the rig for driving the demo.
    const response = await fetch(`${this.baseUrl}/catalog`);
    if (!response.ok) {
      throw new Error(`Merchant catalog returned ${response.status}`);
    }
    return (await response.json()) as { products: unknown[] };
  }

  /** DEMO CONTROL: switch the merchant's simulated outage on or off. */
  async setOutage(down: boolean): Promise<{ down: boolean }> {
    const response = await fetch(`${this.baseUrl}/demo/outage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ down }),
    });
    if (!response.ok) throw new Error(`Merchant outage control returned ${response.status}`);
    return (await response.json()) as { down: boolean };
  }

  async outage(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/demo/outage`);
      return response.ok ? ((await response.json()) as { down: boolean }).down : true;
    } catch {
      return true; // unreachable counts as down
    }
  }

  async setPrice(productId: string, price: number): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/demo/price`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: productId, price }),
    });
    if (!response.ok) {
      throw new Error(`Merchant price update returned ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }
}
