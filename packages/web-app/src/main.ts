import { startWebApp } from "./server.ts";

/** Entry point for `npm run dev:web-app`. */
const port = Number(process.env.WEB_PORT ?? 4030);
const mcpUrl = process.env.MCP_URL ?? "http://127.0.0.1:4020/mcp";
const merchantUrl = process.env.MERCHANT_URL ?? "http://127.0.0.1:4010";

const { url } = await startWebApp(port, { mcpUrl, merchantUrl });

console.log(`[web-app]  dashboard  ${url}`);
console.log(`[web-app]  mcp-server ${mcpUrl}`);
console.log(`[web-app]  merchant   ${merchantUrl}`);
