import { McpClient } from "@strands-agents/sdk";

/**
 * Vouch's MCP tools, as an agent sees them.
 *
 * This is step one of the orchestrator: the connection and the toolset, with
 * no model attached. Splitting it that way is deliberate — fused together,
 * a failure tells you nothing about whether the SDK wiring is wrong or the
 * model reasoned badly. Everything here is deterministic and testable; the
 * model arrives in the next step and brings the only nondeterminism with it.
 *
 * API NOTE, verified against @strands-agents/sdk 1.18.0 rather than assumed.
 * BUILD_PLAN.md §3's week-2 sketch said to pair `McpClient` with
 * `StreamableHTTPClientTransport` from the MCP SDK by hand, because the
 * Strands docs' example used stdio. That is no longer necessary: `McpClient`
 * takes a `url` and builds a Streamable HTTP transport itself. The manual
 * `transport` option still exists for cases this does not cover, and is what
 * a stdio server would need.
 *
 * Also worth knowing for later: the constructor accepts `auth` (OAuth
 * client-credentials) and `headers`. If the Alexa+ add-on path in §7 ever
 * unblocks and the MCP server grows the OAuth 2.1 layer it requires, the
 * orchestrator gets there through `auth` rather than a rewrite.
 */

/** The tools packages/mcp-server advertises. Pinned so a silent rename is caught. */
export const EXPECTED_VOUCH_TOOLS = [
  "approve_purchase",
  "create_mandate",
  "explain_vouch",
  "get_mandate",
  "list_mandates",
  "list_vouches",
  "pause_mandate",
  "propose_purchase",
  "record_dispute",
  "search_catalog",
] as const;

export interface VouchToolsetOptions {
  /** The MCP server's Streamable HTTP endpoint, e.g. http://127.0.0.1:4020/mcp */
  url: string;
  /**
   * When true a connection failure is logged rather than thrown, and the
   * client sits in a `failed` state. Left OFF by default: an orchestrator
   * that silently has no tools would still answer the household, just with
   * nothing behind it, and "the agent forgot it could buy things" is a much
   * worse failure than a startup crash.
   */
  continueOnError?: boolean;
}

export function createVouchMcpClient(options: VouchToolsetOptions): McpClient {
  return new McpClient({
    url: options.url,
    continueOnError: options.continueOnError ?? false,
    applicationName: "vouch-orchestrator",
  });
}

export interface ConnectedToolset {
  client: McpClient;
  /** Tool names as the agent will see them, sorted for stable comparison. */
  toolNames: string[];
  disconnect(): Promise<void>;
}

/**
 * Connects and lists. Verifying the tool names here rather than trusting the
 * connection is the point of this step: a connected client that advertises
 * the wrong tools looks healthy and fails later, inside a model call, where
 * the cause is much harder to see.
 */
export async function connectVouchToolset(
  options: VouchToolsetOptions
): Promise<ConnectedToolset> {
  const client = createVouchMcpClient(options);
  await client.connect();
  const tools = await client.listTools();

  return {
    client,
    toolNames: tools.map((tool) => tool.name).sort(),
    disconnect: () => client.disconnect(),
  };
}

/**
 * Names advertised by the server that this project did not expect, and
 * expected names the server did not advertise. Returned rather than thrown
 * so a caller can decide: a missing tool is fatal for the agent, while an
 * unexpected extra one is usually just this list being out of date.
 */
export function diffToolNames(actual: string[]): { missing: string[]; unexpected: string[] } {
  const expected = new Set<string>(EXPECTED_VOUCH_TOOLS);
  const seen = new Set(actual);
  return {
    missing: [...expected].filter((name) => !seen.has(name)).sort(),
    unexpected: actual.filter((name) => !expected.has(name)).sort(),
  };
}
