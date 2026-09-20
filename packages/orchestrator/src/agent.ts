import { Agent, AfterToolCallEvent, ModelRetryStrategy } from "@strands-agents/sdk";
import type { AfterModelCallEvent } from "@strands-agents/sdk";
import { GoogleModel } from "@strands-agents/sdk/models/google";
import { connectVouchToolset, type VouchToolsetOptions } from "./toolset.ts";

/**
 * Retries a model call that was rate-limited, waiting as long as the provider
 * asked to be waited for.
 *
 * Strands ships `DefaultModelRetryStrategy`, but it only treats
 * `ModelThrottledError` as retryable, and Gemini's 429 arrives wrapped as a
 * plain `ModelError`, so nothing retried. Measured on the free tier: the
 * binding limit is **5 requests per minute**, not the 20-per-day figure that
 * was more obvious — and one conversational turn costs several requests,
 * because every tool result goes back to the model for another call. So a
 * single agent turn can rate-limit itself halfway through.
 *
 * This matters well beyond the test suite. A demo recording that dies on a
 * 429 in the middle of the one sequence the submission is built around is a
 * far worse outcome than one that pauses for forty seconds.
 *
 * Google states how long to wait in the error body (`"retryDelay": "42s"`),
 * so that value is parsed and honoured rather than guessed at with a fixed
 * backoff that would either give up too early or sleep far longer than needed.
 */
export class QuotaAwareRetryStrategy extends ModelRetryStrategy {
  readonly name = "vouch-quota-aware-retry";
  private readonly maxAttempts: number;

  constructor(maxAttempts = 4) {
    super();
    this.maxAttempts = maxAttempts;
  }

  protected computeRetryDecision(event: AfterModelCallEvent) {
    const message = event.error instanceof Error ? event.error.message : String(event.error ?? "");
    const rateLimited = message.includes("429") || message.includes("RESOURCE_EXHAUSTED");

    if (!rateLimited || event.attemptCount >= this.maxAttempts) {
      return { retry: false as const };
    }

    // e.g. "retryDelay": "42s" — seconds only, which is all Google sends.
    const asked = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
    const waitMs = asked
      ? Math.ceil(Number(asked[1]) * 1000) + 1_000 // a second's grace either side of their clock
      : Math.min(60_000, 2_000 * 2 ** (event.attemptCount - 1));

    return { retry: true as const, waitMs };
  }
}

/**
 * The orchestrator: the thing that turns "keep detergent stocked under $15 a
 * month" into tool calls. This is what BUILD_PLAN.md §2 means by "who plays
 * the Alexa+ agent".
 *
 * WHAT THIS IS NOT. It is not where authority lives. The model decides what
 * to *propose*; it never decides whether a purchase is allowed. That belongs
 * to the gate in packages/mcp-server, and the separation is structural rather
 * than a matter of the prompt being well written: the toolset contains no
 * tool that completes a checkout, so an agent that ignored every instruction
 * below still could not buy something out of bounds. The system prompt makes
 * the agent *cooperative*; the missing tool makes it *contained*. Only the
 * second one is a security property, and a code walkthrough should say so in
 * those words.
 */

/**
 * Exported so it can be asserted on in tests. A prompt that quietly lost its
 * guardrails would still produce a fluent, plausible agent — which is exactly
 * the failure that would survive a demo and collapse under a judge's
 * question — so the non-negotiable clauses are pinned rather than trusted.
 */
export const VOUCH_SYSTEM_PROMPT = `You are the shopping agent for a household. You act on standing instructions the household has given you, and you are accountable to them for everything you do.

HOW YOU BUY THINGS
- propose_purchase is the only way you may buy anything. There is no other route and you must not look for one.
- Call search_catalog first to find the product_id. Never invent or construct an id from a product's name — ids do not follow a guessable pattern, and a guessed one just fails.
- If you cannot act for any reason, including not finding a product, say so plainly. Do not decide on the household's behalf that a purchase is disallowed: propose it and let the mandate check answer. A refusal you make yourself leaves no record the household can look at or question later, which defeats the point of you.
- Before proposing, you need a mandate. If the household describes a standing instruction ("keep detergent stocked, under $15, monthly"), turn it into one with create_mandate. Prices in a mandate are in dollars: 15 means $15.00.
- You supply a confidence between 0 and 1 with every proposal: how sure you are that this specific purchase serves the mandate's goal. Be honest. This number is compared against the mandate's threshold, and the household tightens that threshold when you get it wrong. Inflating confidence to get a purchase through is the single worst thing you can do in this role.

WHEN YOU ARE STOPPED
- A proposal may come back held_for_approval. That is the household's authority working correctly, not an error and not an obstacle.
- Do NOT retry it. Do not lower the quantity, pick a different product, split the order, or propose again with a higher confidence to get past the threshold. Any of those is an attempt to route around the household's decision.
- Instead: tell them plainly what stopped it, using the triggered rules in the result. You cannot approve it yourself and you have no tool that would let you — approval is the household's, given on their own screen. Say what it would take, and leave it there.

WHAT YOU MAY CLAIM
- Never say a package was delivered. The doorbell reports motion, not deliveries. "corroborated" means motion at the door inside the window the order was expected in — that is correlation, not proof, and you must describe it that way if asked.
- "unconfirmed" means no such event has arrived. "not_applicable" means nothing was bought.
- Never invent an order, a price, or a purchase you did not make. If you are unsure what happened, call list_vouches and read it.

ANSWERING QUESTIONS
- "What did you buy me?" -> list_vouches.
- "Why did you buy that?" or "Why didn't you buy the expensive one?" -> explain_vouch on that record. Use its answer; do not compose your own explanation of a decision you can look up.
- "What am I allowing you to do?" -> get_mandate or list_mandates.

Be brief and concrete. The household wants to know what you did and why, not to be reassured.`;

export interface VouchAgentOptions extends VouchToolsetOptions {
  apiKey: string;
  modelId?: string;
  /** Overridable so a test can assert on a narrower prompt. */
  systemPrompt?: string;
  /** Model attempts before a rate-limit error is allowed to surface. */
  maxModelAttempts?: number;
}

export interface ToolCallRecord {
  name: string;
  /** True when the tool itself reported failure, e.g. an unknown mandate id. */
  failed: boolean;
}

export interface VouchAgent {
  agent: Agent;
  /** Tool names the agent was given, sorted. */
  toolNames: string[];
  /** Every tool call made, in order, across all turns. */
  calls: ToolCallRecord[];
  ask(message: string): Promise<AskResult>;
  disconnect(): Promise<void>;
}

export interface AskResult {
  text: string;
  /** Tool calls made during THIS turn only. */
  toolCalls: ToolCallRecord[];
  stopReason: string;
}

/**
 * Flash, not Flash-Lite. **Flash-Lite was tried on 2026-09-20 and rejected**,
 * and the evidence is recorded here so it is not retried on the assumption
 * that a cheaper model is obviously the answer to the quota problem.
 *
 * The attraction was real: free-tier quota is bucketed PER MODEL (the 429's
 * `quotaDimensions` names the model explicitly), so moving would have bought
 * a fresh budget as well as a lighter model. But on Flash-Lite the agent
 * returned **empty replies and made no tool calls** — 1 of 5 live tests
 * passed, the assertion inputs came back as `''`, and a demo rehearsal
 * stalled on its first turn. On Flash the same code calls `search_catalog`
 * unprompted and reports real product ids.
 *
 * It answers a plain prompt fine, which is what made it look viable: the
 * standalone `npm run check:model` passes on Flash-Lite. Tool-calling is
 * where it falls over, and tool-calling is this component's entire job.
 *
 * This stays a constructor argument: Bedrock replaces it when the AWS credit
 * lands, with no other change.
 */
export const DEFAULT_MODEL_ID = "gemini-2.5-flash";

/**
 * Wires a model to Vouch's MCP tools and returns something you can talk to.
 *
 * The tool calls are recorded through a hook rather than inferred from the
 * reply, because what the agent *says* it did and what it actually did are
 * different claims — and the entire product is about preferring the second.
 * A test that checked only the text would pass for an agent that claimed to
 * have bought something it never proposed.
 */
export async function createVouchAgent(options: VouchAgentOptions): Promise<VouchAgent> {
  const toolset = await connectVouchToolset({
    url: options.url,
    continueOnError: options.continueOnError ?? false,
  });
  const tools = await toolset.client.listTools();

  const agent = new Agent({
    model: new GoogleModel({
      apiKey: options.apiKey,
      modelId: options.modelId ?? DEFAULT_MODEL_ID,
    }),
    systemPrompt: options.systemPrompt ?? VOUCH_SYSTEM_PROMPT,
    tools,
    // Per the SDK's note, a strategy carries per-budget state and must not be
    // shared between agents, so it is constructed here rather than module-wide.
    retryStrategy: new QuotaAwareRetryStrategy(options.maxModelAttempts ?? 4),
  });

  const calls: ToolCallRecord[] = [];
  agent.addHook(AfterToolCallEvent, (event) => {
    calls.push({
      name: event.toolUse.name,
      failed: event.error !== undefined || event.result.status === "error",
    });
  });

  return {
    agent,
    toolNames: toolset.toolNames,
    calls,
    async ask(message: string): Promise<AskResult> {
      const before = calls.length;
      const result = await agent.invoke(message);
      const text = result.lastMessage.content
        .map((block) => ("text" in block ? block.text : ""))
        .join("")
        .trim();
      return { text, toolCalls: calls.slice(before), stopReason: String(result.stopReason) };
    },
    disconnect: () => toolset.disconnect(),
  };
}

/** Reads the key from the environment, with an error that says what to do. */
export function requireGeminiKey(env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env, add the key, and run with " +
        "`node --env-file-if-exists=.env`. Never commit it."
    );
  }
  return apiKey;
}
