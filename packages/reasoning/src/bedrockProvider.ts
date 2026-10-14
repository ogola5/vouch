import type { Mandate, Vouch } from "@vouch/shared";
import type {
  ExplainVouchInput,
  ReasoningProvider,
  ThresholdAdjustment,
  ThresholdAdjustmentInput,
} from "./types.ts";

/**
 * BedrockReasoningProvider (BUILD_PLAN.md §3b W6): the plain-language "why"
 * on a Vouch, written by a model from the record's own facts.
 *
 * WHAT THE MODEL MAY DO, AND WHAT IT MAY NOT.
 *  - It writes the explanation. Nothing else. Threshold adjustment is
 *    delegated to the deterministic provider: the number that moves the
 *    agent's authority must be reproducible, and is tuned by simulation
 *    (packages/eval), not by a model's judgement.
 *  - It is given the record as facts and told to use only them. Then its
 *    text is CHECKED, not trusted: every number in it must appear in the
 *    record; it must name the price and what stopped the purchase; it must
 *    not claim a purchase or a delivery that did not happen. Anything that
 *    fails a check is discarded and the rule-based text is used instead,
 *    with the reason kept so the fallback is visible rather than silent.
 *  - On any error, timeout or missing key: the rule-based text. The
 *    explanation is never the reason a record cannot be read.
 *
 * TRANSPORT. Bedrock's Converse API over plain fetch with the API key as a
 * bearer token — no AWS SDK in this package, for the same reason the repo
 * uses node:http over Express. The live test (test/explain-live.test.ts)
 * is the proof that this request shape works, not this comment.
 */

export type ExplanationSource = "model" | "rules";

export interface Explanation {
  text: string;
  source: ExplanationSource;
  /** Why the model's text was not used, when it was not. */
  fallback_reason?: string;
}

export interface BedrockReasoningOptions {
  apiKey: string;
  modelId: string;
  region: string;
  /** Used for every threshold adjustment, and for any explanation the model cannot give. */
  fallback: ReasoningProvider;
  timeoutMs?: number;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = [
  "You explain one purchase record to the household that owns it, in two or three plain sentences.",
  "Speak as their household agent, in the first person.",
  "Use ONLY the facts you are given. Never add a number, price, date, brand or reason that is not in the facts.",
  "If the purchase was held, say what stopped it (name the rule in everyday words, with its numbers) and that it is waiting for them.",
  "If it was bought, say why it was within what they allowed.",
  "If it failed or was cancelled, say plainly that nothing was bought.",
  "A doorbell motion event is a correlation, never proof of delivery: never say anything was delivered.",
  "No greetings, no lists, no markdown.",
].join(" ");

/** The record, reduced to what the explanation may draw on. */
export function explanationFacts(vouch: Vouch, mandate: Mandate) {
  const c = mandate.constraints as Record<string, unknown>;
  return {
    status: vouch.action.status,
    product: vouch.decision.product,
    price: vouch.decision.price,
    goal: mandate.goal,
    limits: {
      max_price: c.max_price ?? null,
      preferred_brand: c.preferred_brand ?? null,
      fallback_brand: c.fallback_brand ?? null,
    },
    stopped_by: vouch.authority.triggered_rules,
    checks: (vouch.authority.checks ?? []).map((k) => ({ rule: k.rule, passed: k.passed, detail: k.detail })),
    confidence: vouch.authority.confidence_score,
    threshold: vouch.authority.threshold_applied,
    evidence_notes: vouch.authority.confidence_basis?.notes ?? null,
    started_by: vouch.trace?.started_by ?? null,
    doorbell: vouch.evidence.physical.correlation_status,
    failure: vouch.failure?.message ?? null,
    disputed: vouch.dispute !== null,
  };
}

/** Everyday words a held explanation must use for each rule that stopped it. */
const RULE_WORDS: Record<string, RegExp> = {
  "price > max_price": /limit|max|over|above|more than|exceed|higher/i,
  new_brand: /brand/i,
  below_confidence_threshold: /confiden|sure|certain|threshold/i,
  mandate_paused: /pause/i,
  autonomy_not_granted: /ask|permission|approv|on (its|my) own/i,
  autonomy_expired: /expir|ended|lapsed/i,
};

/** Every number a sentence about these facts may contain. */
function allowedNumbers(facts: ReturnType<typeof explanationFacts>): number[] {
  const out: number[] = [];
  for (const m of JSON.stringify(facts).matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    out.push(n, Math.round(n));
    if (n > 0 && n < 1) out.push(Math.round(n * 100)); // 0.88 may be said as 88%
  }
  return out;
}

/**
 * Checks a model-written explanation against the record. Returns the reason
 * it fails, or null if it may be shown.
 */
export function checkExplanation(text: string, facts: ReturnType<typeof explanationFacts>): string | null {
  const t = text.trim();
  if (!t) return "empty";
  if (t.length > 700) return "too long";

  const allowed = allowedNumbers(facts);
  for (const m of t.replace(/(\d),(\d{3})/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (!allowed.some((a) => Math.abs(a - n) < 1e-9)) return `number not in the record: ${m[0]}`;
  }

  if (facts.price !== null && facts.status !== "Failed" && !t.includes(facts.price.toFixed(2)) && !t.includes(String(facts.price))) {
    return "does not name the price";
  }

  if (facts.status === "PendingApproval") {
    // Matched outside the product's own name: "Brand C Detergent" says "brand"
    // without saying anything about why it was stopped.
    const withoutProduct = t.split(facts.product).join(" ");
    for (const rule of facts.stopped_by) {
      const words = RULE_WORDS[rule];
      if (words && !words.test(withoutProduct)) return `does not say what stopped it (${rule})`;
    }
  }

  if (/\bdeliver(ed|y (was )?(confirmed|complete))\b|\bproof\b|\bproves?\b/i.test(t)) return "claims a delivery";
  if (facts.status !== "Complete" && /\b(I|we)\s+(have\s+)?(bought|purchased|ordered)\b/i.test(t)) {
    return "claims a purchase that did not happen";
  }
  return null;
}

export class BedrockReasoningProvider implements ReasoningProvider {
  private readonly options: BedrockReasoningOptions;
  private readonly fetchImpl: typeof fetch;
  /** Model answers only, keyed by what would change the answer. Fallbacks are retried next time. */
  private readonly cache = new Map<string, Explanation>();

  constructor(options: BedrockReasoningOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get modelId(): string {
    return this.options.modelId;
  }

  async explainVouch(input: ExplainVouchInput): Promise<string> {
    return (await this.explain(input)).text;
  }

  async explain({ vouch, mandate }: ExplainVouchInput): Promise<Explanation> {
    const key = `${vouch.vouch_id}:${vouch.action.status}:${vouch.dispute ? 1 : 0}:${vouch.evidence.physical.correlation_status}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const facts = explanationFacts(vouch, mandate);
    const fallback = async (reason: string): Promise<Explanation> => ({
      text: await this.options.fallback.explainVouch({ vouch, mandate }),
      source: "rules",
      fallback_reason: reason,
    });

    let text: string;
    try {
      text = await this.converse(JSON.stringify(facts));
    } catch (error) {
      return fallback(`model unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const problem = checkExplanation(text, facts);
    if (problem) return fallback(`model text rejected: ${problem}`);

    const result: Explanation = { text: text.trim(), source: "model" };
    this.cache.set(key, result);
    return result;
  }

  adjustConfidenceThreshold(input: ThresholdAdjustmentInput): Promise<ThresholdAdjustment> {
    return this.options.fallback.adjustConfidenceThreshold(input);
  }

  private async converse(factsJson: string): Promise<string> {
    const { region, modelId, apiKey } = this.options;
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: "user", content: [{ text: `The record:\n${factsJson}` }] }],
        inferenceConfig: { maxTokens: 220, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 8000),
    });
    if (!res.ok) {
      // Bedrock's own message, short: it names the field it objected to.
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
      throw new Error(`Bedrock answered ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = (await res.json()) as { output?: { message?: { content?: { text?: string }[] } } };
    const text = (body.output?.message?.content ?? []).map((c) => c.text ?? "").join("").trim();
    if (!text) throw new Error("empty answer");
    return text;
  }
}
