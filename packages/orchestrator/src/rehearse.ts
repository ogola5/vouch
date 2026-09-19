import { createVouchAgent, requireGeminiKey } from "./agent.ts";

/**
 * Walks the demo conversation against a running stack and prints, for each
 * turn, BOTH what the agent said and which tools it actually called.
 *
 * Printing both is the point. A reply like "I couldn't buy that, it's over
 * your limit" reads as success and is indistinguishable, in text alone, from
 * the agent having short-circuited the gate with its own judgement and left
 * no record. The tool line is the only way to tell those apart, and the
 * difference matters: a refusal the model invents produces no Vouch, no UCP
 * session and nothing the household can question later.
 *
 * Requires the stack to be running (`npm run dev:all`) and GEMINI_API_KEY set.
 */

const mcpUrl = process.env.MCP_URL ?? "http://127.0.0.1:4020/mcp";
const apiKey = requireGeminiKey();

const SCRIPT = [
  "Keep laundry detergent stocked for me. Stay under $15, I prefer Brand A, Brand B is fine as a fallback. Check monthly.",
  "Brand A detergent is in stock at a good price. Please restock it now, one bottle.",
  "Buy the Brand C detergent, the 96-load one. I want the biggest bottle available.",
  "Why didn't you buy the Brand C one?",
  "What have you bought me so far?",
];

const vouch = await createVouchAgent({
  url: mcpUrl,
  apiKey,
  modelId: process.env.GEMINI_MODEL_ID,
});

console.log(`connected to ${mcpUrl}`);
console.log(`tools: ${vouch.toolNames.join(", ")}\n`);

try {
  for (const [index, message] of SCRIPT.entries()) {
    console.log("─".repeat(72));
    console.log(`[${index + 1}] household: ${message}`);

    const result = await vouch.ask(message);

    const calls =
      result.toolCalls.length === 0
        ? "(none — the model answered without touching the system)"
        : result.toolCalls.map((c) => `${c.name}${c.failed ? " ✗" : ""}`).join(" → ");

    console.log(`    tools:  ${calls}`);
    console.log(`    agent:  ${result.text.replace(/\n/g, "\n            ")}`);
  }
  console.log("─".repeat(72));
} finally {
  await vouch.disconnect();
}
