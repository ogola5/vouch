import { probeMcp } from "../src/probe.ts";

/**
 * npm run probe:mcp — an outside MCP client against a running Vouch server.
 * Run it during the demo to show the server is pluggable: nothing here is
 * shared with the console or the agent. See src/probe.ts for what it leaves
 * behind (one mandate "m_probe", one held checkout per run; nothing bought).
 */

const url = process.env.MCP_URL ?? "http://127.0.0.1:4020/mcp";
console.log(`\nVouch — an outside MCP client, connecting cold to ${url}\n`);
try {
  const report = await probeMcp(url);
  for (const s of report.steps) console.log(`  ${s.ok ? "✓" : "✗"} ${s.step}\n      ${s.detail}`);
  console.log(`\n${report.passed ? "PASS — the gate held for a client it has never seen." : "FAIL — see the ✗ above."}\n`);
  process.exit(report.passed ? 0 : 1);
} catch (error) {
  console.error(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}\nIs the stack running? npm run dev:all`);
  process.exit(1);
}
