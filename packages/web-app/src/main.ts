import { startWebApp } from "./server.ts";

/** Entry point for `npm run dev:web-app`. */
const port = Number(process.env.WEB_PORT ?? 4030);
const mcpUrl = process.env.MCP_URL ?? "http://127.0.0.1:4020/mcp";
const merchantUrl = process.env.MERCHANT_URL ?? "http://127.0.0.1:4010";
// A separate port, not derived from MCP_URL: the household surface is
// loopback-only so that tunnelling /mcp cannot publish it. See
// packages/mcp-server/src/server.ts.
const householdUrl = process.env.HOUSEHOLD_URL ?? "http://127.0.0.1:4021";

const { url } = await startWebApp(port, { mcpUrl, merchantUrl, householdUrl });

console.log(`[web-app]  dashboard  ${url}`);
console.log(`[web-app]  mcp-server ${mcpUrl}`);
console.log(`[web-app]  household  ${householdUrl}`);
console.log(`[web-app]  merchant   ${merchantUrl}`);
