import { evaluateProposal, newMandate, type Mandate } from "@vouch/shared";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";

/**
 * Does the adaptive loop actually work?
 *
 * The test suite proves the code does what it was built to do. It proves
 * nothing about whether the MECHANISM — dispute, tightened threshold, fewer
 * repeat bad purchases — holds up over a household's history. That is a
 * different question and it needs evidence, not unit tests.
 *
 * WHAT THIS IS NOT. It is not a claim about real households. Nobody has run
 * Vouch in a real home, and the behaviour here is synthetic. What it IS is a
 * falsifiable experiment on the mechanism: given an agent whose confidence is
 * imperfectly correlated with what a household actually wanted — which is the
 * only interesting case, since a perfect agent needs no gate — does moving
 * the threshold from disputes beat leaving it alone?
 *
 * HOW IT COULD FAIL, stated before the numbers, because a result you cannot
 * lose is not a result. Tightening has a price: the same move that blocks an
 * unwanted purchase also blocks a wanted one near the boundary. If harm falls
 * only as fast as cost rises, the loop is an expensive way of doing nothing
 * and this file should say so. Both are measured and both are reported.
 */

/* -------------------------------------------------------------------------
 * Deterministic randomness
 * ---------------------------------------------------------------------- */

/**
 * mulberry32 — a small seeded PRNG.
 *
 * Seeded on purpose: a validation number nobody else can reproduce is an
 * anecdote. Every figure this file publishes can be re-derived by running it
 * again, and `test/claims.test.ts` does exactly that.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, clamped to [0,1] since it stands in for a confidence. */
function normal(rng: () => number, mean: number, sd: number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(1, Math.max(0, mean + z * sd));
}

/* -------------------------------------------------------------------------
 * The world
 * ---------------------------------------------------------------------- */

export interface TrialConfig {
  households: number;
  /** Purchase opportunities each household sees, in order. */
  opportunitiesPerHousehold: number;
  /** Share of opportunities the household would NOT have wanted. */
  unwantedRate: number;
  /** The agent's confidence when the purchase was in fact wanted. */
  wantedConfidence: { mean: number; sd: number };
  /** The agent's confidence when it was not. Overlapping on purpose. */
  unwantedConfidence: { mean: number; sd: number };
  startingThreshold: number;
  seed: number;
  /** Loop tuning under test. Omitted means the provider's shipped defaults. */
  tuning?: { disputeTightenStep?: number; streakLoosenStep?: number; streakLoosenEvery?: number };
}

/**
 * Defaults chosen to be unflattering rather than flattering.
 *
 * The two confidence distributions overlap heavily — mean 0.88 against 0.80
 * with wide spread — so no threshold can cleanly separate wanted from
 * unwanted. A well-separated agent would make the loop look excellent and
 * would also mean the gate was barely needed. The hard case is the honest one.
 */
export const DEFAULT_TRIAL: TrialConfig = {
  households: 200,
  opportunitiesPerHousehold: 60,
  unwantedRate: 0.3,
  wantedConfidence: { mean: 0.88, sd: 0.08 },
  unwantedConfidence: { mean: 0.8, sd: 0.1 },
  startingThreshold: 0.85,
  seed: 20260923,
};

export interface ArmResult {
  /** Unwanted purchases that completed — the harm the gate exists to prevent. */
  unwantedCompleted: number;
  /** Wanted purchases held for approval — what tightening costs. */
  wantedHeld: number;
  wantedCompleted: number;
  unwantedHeld: number;
  totalOpportunities: number;
  /** Threshold at the end, averaged over households. */
  meanFinalThreshold: number;
}

export interface TrialResult {
  config: TrialConfig;
  adaptive: ArmResult;
  static: ArmResult;
  /** Unwanted completions in the LAST quarter of each history, both arms. */
  lateHarm: { adaptive: number; static: number; opportunities: number };
  generated_at: string;
}

interface Opportunity {
  wanted: boolean;
  confidence: number;
}

function buildHistory(rng: () => number, config: TrialConfig): Opportunity[] {
  const out: Opportunity[] = [];
  for (let i = 0; i < config.opportunitiesPerHousehold; i++) {
    const wanted = rng() >= config.unwantedRate;
    const dist = wanted ? config.wantedConfidence : config.unwantedConfidence;
    out.push({ wanted, confidence: normal(rng, dist.mean, dist.sd) });
  }
  return out;
}

function emptyArm(): ArmResult {
  return {
    unwantedCompleted: 0,
    wantedHeld: 0,
    wantedCompleted: 0,
    unwantedHeld: 0,
    totalOpportunities: 0,
    meanFinalThreshold: 0,
  };
}

/**
 * Runs both arms over the SAME generated histories.
 *
 * Paired on purpose: each household's opportunities and the agent's
 * confidences are identical in both arms, so the only difference is whether
 * the threshold is allowed to move. Generating fresh histories per arm would
 * mix the mechanism's effect with sampling noise and make a small difference
 * unreadable.
 */
export async function runTrial(config: TrialConfig = DEFAULT_TRIAL): Promise<TrialResult> {
  const reasoning = new RuleBasedReasoningProvider(config.tuning ?? {});
  const adaptive = emptyArm();
  const fixed = emptyArm();
  const lateWindow = Math.floor(config.opportunitiesPerHousehold * 0.25);
  const lateHarm = { adaptive: 0, static: 0, opportunities: 0 };

  let adaptiveThresholdSum = 0;
  let staticThresholdSum = 0;

  for (let h = 0; h < config.households; h++) {
    // One seed per household, derived from the trial seed, so a single
    // household's run can be reproduced in isolation when a result looks odd.
    const history = buildHistory(mulberry32(config.seed + h * 7919), config);

    const base = (id: string): Mandate =>
      newMandate({
        mandate_id: id,
        goal: "Keep household staples stocked",
        constraints: { max_price: 15 },
        // Only the confidence rule is in play. Price and brand rules would
        // block purchases for reasons unrelated to the mechanism under test
        // and would flatter the adaptive arm by accident.
        requires_approval_if: [],
        authority_type: "explicit",
        confidence_threshold: config.startingThreshold,
      });

    let adaptiveMandate = base(`h${h}-adaptive`);
    const staticMandate = base(`h${h}-static`);
    let streak = 0;

    for (const [index, opportunity] of history.entries()) {
      const isLate = index >= config.opportunitiesPerHousehold - lateWindow;
      if (isLate) lateHarm.opportunities += 1;

      const proposal = {
        price: 12,
        quantity: 1,
        brand: "Brand A",
        confidence: opportunity.confidence,
      };

      /* ---- static arm: the threshold never moves ---- */
      const staticOutcome = evaluateProposal(staticMandate, proposal);
      fixed.totalOpportunities += 1;
      if (staticOutcome.withinBounds) {
        if (opportunity.wanted) fixed.wantedCompleted += 1;
        else {
          fixed.unwantedCompleted += 1;
          if (isLate) lateHarm.static += 1;
        }
      } else if (opportunity.wanted) fixed.wantedHeld += 1;
      else fixed.unwantedHeld += 1;

      /* ---- adaptive arm: disputes move the threshold ---- */
      const adaptiveOutcome = evaluateProposal(adaptiveMandate, proposal);
      adaptive.totalOpportunities += 1;

      if (adaptiveOutcome.withinBounds) {
        if (opportunity.wanted) {
          adaptive.wantedCompleted += 1;
          streak += 1;
          // Recovery: a run of undisputed purchases widens the threshold back.
          const loosen = await reasoning.adjustConfidenceThreshold({
            mandate: adaptiveMandate,
            event: { kind: "undisputed_streak", streakLength: streak },
          });
          adaptiveMandate = {
            ...adaptiveMandate,
            confidence_threshold: loosen.newThreshold,
            history: { ...adaptiveMandate.history, undisputed_actions: streak },
          };
        } else {
          adaptive.unwantedCompleted += 1;
          if (isLate) lateHarm.adaptive += 1;
          // The household disputes it. This is the only thing that tightens.
          streak = 0;
          const tighten = await reasoning.adjustConfidenceThreshold({
            mandate: adaptiveMandate,
            event: { kind: "dispute" },
          });
          adaptiveMandate = {
            ...adaptiveMandate,
            confidence_threshold: tighten.newThreshold,
            history: {
              ...adaptiveMandate.history,
              disputed_actions: adaptiveMandate.history.disputed_actions + 1,
              undisputed_actions: 0,
            },
          };
        }
      } else if (opportunity.wanted) {
        // Held a purchase the household wanted. The cost of tightening, and
        // it is counted rather than quietly dropped.
        adaptive.wantedHeld += 1;
      } else {
        adaptive.unwantedHeld += 1;
      }
    }

    adaptiveThresholdSum += adaptiveMandate.confidence_threshold;
    staticThresholdSum += staticMandate.confidence_threshold;
  }

  adaptive.meanFinalThreshold = adaptiveThresholdSum / config.households;
  fixed.meanFinalThreshold = staticThresholdSum / config.households;

  return {
    config,
    adaptive,
    static: fixed,
    lateHarm,
    generated_at: new Date().toISOString(),
  };
}

/** Percentage reduction in late-history harm, adaptive vs static. */
export function lateHarmReduction(result: TrialResult): number {
  const { adaptive, static: fixed } = result.lateHarm;
  if (fixed === 0) return 0;
  return ((fixed - adaptive) / fixed) * 100;
}

/** Extra wanted purchases the adaptive arm held — what the reduction cost. */
export function costOfTightening(result: TrialResult): number {
  return result.adaptive.wantedHeld - result.static.wantedHeld;
}
