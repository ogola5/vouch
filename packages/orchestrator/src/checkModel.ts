import { Agent } from "@strands-agents/sdk";
import { buildModel, resolveModelConfig } from "./agent.ts";

/**
 * A one-command check that the model provider is wired up, run BEFORE any
 * agent-loop work depends on it.
 *
 * It exists because "the agent didn't do anything" has too many possible
 * causes once a model is in the loop — a missing key, a wrong model id, a
 * network block, a billing problem, or the model simply choosing not to act.
 * This separates the first four from the last one. Same reasoning that kept
 * the model out of orchestrator step 1 entirely.
 *
 * Passing this does NOT mean the model can do the orchestrator's job:
 * Flash-Lite passed it and still made no tool calls. The live suite is the
 * acceptance test.
 *
 * It never prints the key, and it does not need to be given one: the key is
 * read from the environment, which is where a credential belongs.
 */

const config = resolveModelConfig();

if (!config) {
  console.error(
    [
      "No model key is set.",
      "",
      "  1. cp .env.example .env",
      "  2. put your key in .env as AWS_BEARER_TOKEN_BEDROCK=... (or GEMINI_API_KEY=...)",
      "  3. npm run check:model",
      "",
      ".env is gitignored. Never commit a key, and never paste one into a chat.",
    ].join("\n")
  );
  process.exit(1);
}

console.log(`[check:model] provider  ${config.provider}`);
console.log(`[check:model] model     ${config.modelId}`);
if (config.provider === "bedrock") console.log(`[check:model] region    ${config.region}`);
console.log(`[check:model] key       present (${config.apiKey.length} chars, not shown)`);
console.log(`[check:model] calling…`);

const agent = new Agent({
  model: buildModel(config),
  // No tools and no system prompt: this is a connectivity check, not a
  // behaviour check. Giving it tools here would make a failure ambiguous
  // again, which is the exact thing this script exists to avoid.
});

try {
  const result = await agent.invoke(
    "Reply with exactly the word: ready. No punctuation, no explanation."
  );

  const text = result.lastMessage.content
    .map((block) => ("text" in block ? block.text : ""))
    .join("")
    .trim();

  console.log(`[check:model] reply     "${text}"`);
  console.log(`[check:model] stop      ${result.stopReason}`);
  console.log("");
  console.log(`✅ ${config.provider} is reachable. The orchestrator can be given a model.`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("");
  console.error("❌ The call failed. The key is set, so this is not a missing-key problem.");
  console.error(`   ${message}`);
  console.error("");
  console.error("   Common causes, in the order worth checking:");
  if (config.provider === "bedrock") {
    console.error("   - the API key expired or was deleted in the Bedrock console");
    console.error(`   - "${config.modelId}" is not enabled for this account in ${config.region}`);
    console.error("   - AWS_REGION points at a region the inference profile does not cover");
  } else {
    console.error("   - the key is for a different Google product (needs an AI Studio key)");
    console.error(`   - "${config.modelId}" is not available to this key — try GEMINI_MODEL_ID=gemini-2.5-flash`);
    console.error("   - the key has no quota left, or billing is not enabled");
  }
  process.exit(1);
}
