import { randomUUID } from "node:crypto";
import type { VouchStore } from "@vouch/db";

/**
 * Study mode (BUILD_PLAN.md §3b W5c) — what real people say after trying
 * the product, for the W7 test with 5-8 people.
 *
 * WHAT IT MEASURES, and why each question is there:
 *   trust before / after  "Would you leave it switched on?" 1-5, before the
 *                         tour and after the dispute step.
 *   comprehension         "Why didn't it buy Brand C?" in their own words —
 *                         does the held purchase explain itself?
 *   cost ratio            "How many 'may I buy this?' questions would you
 *                         accept to avoid one unwanted $28 purchase?" — the
 *                         number the simulation's break-even (~4.1 prompts
 *                         per unwanted purchase avoided, packages/eval) needs
 *                         to be judged against.
 *
 * HANDLING PEOPLE'S ANSWERS: consent is required, a code stands in for a
 * name, and everything stays in this computer's database. Every answer is
 * checked here — the page is not trusted to send sane numbers.
 */

export interface StudyResponse {
  id: string;
  created_at: string;
  participant: string;
  trust_before: number;
  trust_after: number;
  comprehension: string;
  /** Auto-flagged: the answer names a real reason (price/limit/brand). A hint — check by hand. */
  named_a_real_reason: boolean;
  cost_ratio: number;
  comment: string;
  used_chat: boolean;
}

const REAL_REASON = /\b(price|pricey|expensive|cost|limit|\$\s?15|15 ?dollars|over|brand|approved|allowed|budget)\b/i;

export function validateStudy(body: Record<string, unknown>): Omit<StudyResponse, "id" | "created_at"> {
  if (body.consent !== true) throw new Error("A study session needs the participant's consent.");
  const participant = String(body.participant ?? "").trim();
  if (!/^[A-Za-z0-9-]{1,20}$/.test(participant)) {
    throw new Error("Use a short code for the participant (letters, numbers, dashes) — never a name.");
  }
  const scale = (v: unknown, label: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`${label} must be a whole number from 1 to 5.`);
    return n;
  };
  const ratio = Number(body.cost_ratio);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1000) throw new Error("The number of questions must be between 0 and 1000.");
  const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const comprehension = text(body.comprehension, 1000);
  if (!comprehension) throw new Error("The 'why did it stop?' answer is empty.");
  return {
    participant,
    trust_before: scale(body.trust_before, "Trust before"),
    trust_after: scale(body.trust_after, "Trust after"),
    comprehension,
    named_a_real_reason: REAL_REASON.test(comprehension),
    cost_ratio: ratio,
    comment: text(body.comment, 1000),
    used_chat: body.used_chat === true,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function studySummary(responses: StudyResponse[]) {
  const moved = responses.map((r) => r.trust_after - r.trust_before);
  return {
    n: responses.length,
    median_trust_before: median(responses.map((r) => r.trust_before)),
    median_trust_after: median(responses.map((r) => r.trust_after)),
    trust_went_up: moved.filter((d) => d > 0).length,
    trust_went_down: moved.filter((d) => d < 0).length,
    median_cost_ratio: median(responses.map((r) => r.cost_ratio)),
    /** The simulation's break-even: above it, the adaptive loop is worth its prompts to that person. */
    break_even: 4.1,
    above_break_even: responses.filter((r) => r.cost_ratio >= 4.1).length,
    named_a_real_reason: responses.filter((r) => r.named_a_real_reason).length,
  };
}

export class Study {
  private readonly store: VouchStore;
  constructor(store: VouchStore) {
    this.store = store;
  }

  save(body: Record<string, unknown>): StudyResponse {
    const response: StudyResponse = { id: `study_${randomUUID()}`, created_at: new Date().toISOString(), ...validateStudy(body) };
    this.store.saveStudyResponse(response.id, response.created_at, response);
    return response;
  }

  list(): { responses: StudyResponse[]; summary: ReturnType<typeof studySummary> } {
    const responses = this.store.listStudyResponses() as StudyResponse[];
    return { responses, summary: studySummary(responses) };
  }
}
