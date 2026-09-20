import { createVouchAgent, type VouchAgent } from "@vouch/orchestrator";

/**
 * Holds the conversation for the console's chat panel.
 *
 * LAZY AND FAILURE-ISOLATED, on purpose. When the orchestrator was split into
 * its own package the stated reason was that the dashboard must still run when
 * the model provider is misconfigured — and wiring chat into this process
 * would have quietly thrown that away if the agent were constructed at
 * startup. So it is built on the first chat message, and a failure to build
 * it is reported as a chat problem rather than taking the server down. You can
 * demo the gate with no API key at all; you just cannot talk to it.
 *
 * That is not only defensive engineering. The console is the household's
 * evidence surface, and evidence that disappears when an unrelated API key
 * expires is not evidence.
 */

export type ChatStatus = "ready" | "unconfigured" | "failed";

/**
 * Turns a provider error into a sentence a person can act on.
 *
 * This is demo-critical rather than cosmetic. A rate-limit error arrives as
 * several hundred characters of nested JSON, and pasting that into the
 * transcript during a recording turns a recoverable pause into something that
 * looks like the system falling over. The orchestrator already retries these
 * (QuotaAwareRetryStrategy); by the time one reaches here the retries are
 * spent, and what the viewer needs is "wait a minute", not a stack of quota
 * metric names.
 */
function humanise(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (raw.includes("429") || raw.includes("RESOURCE_EXHAUSTED")) {
    const retry = /"retryDelay"\s*:\s*"(\d+)/.exec(raw);
    const wait = retry ? ` Try again in about ${retry[1]} seconds.` : " Try again shortly.";
    return `I've hit the model's rate limit.${wait} Nothing below is affected — the gate and your record don't need the model.`;
  }
  if (raw.includes("API key") || raw.includes("API_KEY_INVALID") || raw.includes("401")) {
    return "The model rejected the API key. Check GEMINI_API_KEY in .env.";
  }
  if (raw.includes("ECONNREFUSED") || raw.includes("fetch failed")) {
    return "I couldn't reach the Vouch server. Is `npm run dev:mcp-server` running?";
  }
  // Unrecognised: keep the real message, trimmed. Better a truncated truth
  // than a confident guess about what went wrong.
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}

export interface ChatTurn {
  text: string;
  /** Tool names in call order, for the transcript to render legibly. */
  toolCalls: { name: string; failed: boolean }[];
}

export class ChatSession {
  private readonly mcpUrl: string;
  private agent: VouchAgent | null = null;
  private failure: string | null = null;

  constructor(mcpUrl: string) {
    this.mcpUrl = mcpUrl;
  }

  /** What the page should say about the chat box before anyone types. */
  status(): { status: ChatStatus; detail: string } {
    if (this.failure) return { status: "failed", detail: this.failure };
    if (!process.env.GEMINI_API_KEY?.trim()) {
      return {
        status: "unconfigured",
        detail:
          "No GEMINI_API_KEY, so the chat is off. Everything below still works — " +
          "the gate does not need a model.",
      };
    }
    return { status: "ready", detail: "" };
  }

  async send(message: string): Promise<ChatTurn> {
    const { status, detail } = this.status();
    if (status === "unconfigured") {
      throw new Error(detail);
    }

    if (!this.agent) {
      try {
        this.agent = await createVouchAgent({
          url: this.mcpUrl,
          apiKey: process.env.GEMINI_API_KEY!,
          modelId: process.env.GEMINI_MODEL_ID,
        });
        this.failure = null;
      } catch (error) {
        this.failure = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not start the agent: ${this.failure}`);
      }
    }

    try {
      const result = await this.agent.ask(message);
      return { text: result.text, toolCalls: result.toolCalls };
    } catch (error) {
      throw new Error(humanise(error));
    }
  }

  async close(): Promise<void> {
    await this.agent?.disconnect();
    this.agent = null;
  }
}
