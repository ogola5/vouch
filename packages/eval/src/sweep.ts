import { DEFAULT_TRIAL, lateHarmReduction, runTrial, type TrialResult } from "./simulate.ts";

/**
 * The trade-off curve.
 *
 * Reporting a single "72% fewer unwanted purchases" would be cherry-picking,
 * because every tightening step buys that reduction with wanted purchases
 * held. What a reader needs is the frontier: how much harm each setting
 * removes, and what it costs in the agent's usefulness. Then the chosen
 * operating point is a decision someone can disagree with, rather than a
 * number to be taken on faith.
 *
 * The shipped default (+0.07 per dispute) is in the sweep, and it does not
 * come out well. Leaving it in is the point.
 */

export interface SweepRow {
  label: string;
  disputeTightenStep: number;
  streakLoosenEvery: number;
  /** Late-history reduction in unwanted completions, percent. */
  harmReduction: number;
  /** Wanted purchases held, adaptive minus static. The cost. */
  extraWantedHeld: number;
  /** Share of wanted purchases the agent still completed. */
  wantedCompletionRate: number;
  meanFinalThreshold: number;
}

const CANDIDATES: { label: string; disputeTightenStep: number; streakLoosenEvery: number }[] = [
  { label: "no adaptation (control)", disputeTightenStep: 0, streakLoosenEvery: 3 },
  { label: "gentle  +0.01 / recover 2", disputeTightenStep: 0.01, streakLoosenEvery: 2 },
  { label: "gentle  +0.02 / recover 2", disputeTightenStep: 0.02, streakLoosenEvery: 2 },
  { label: "medium  +0.03 / recover 2", disputeTightenStep: 0.03, streakLoosenEvery: 2 },
  { label: "medium  +0.03 / recover 3", disputeTightenStep: 0.03, streakLoosenEvery: 3 },
  { label: "shipped +0.07 / recover 3", disputeTightenStep: 0.07, streakLoosenEvery: 3 },
];

function toRow(label: string, step: number, every: number, result: TrialResult): SweepRow {
  const wantedTotal = result.adaptive.wantedCompleted + result.adaptive.wantedHeld;
  return {
    label,
    disputeTightenStep: step,
    streakLoosenEvery: every,
    harmReduction: lateHarmReduction(result),
    extraWantedHeld: result.adaptive.wantedHeld - result.static.wantedHeld,
    wantedCompletionRate: (result.adaptive.wantedCompleted / wantedTotal) * 100,
    meanFinalThreshold: result.adaptive.meanFinalThreshold,
  };
}

export async function runSweep(): Promise<SweepRow[]> {
  const rows: SweepRow[] = [];
  for (const candidate of CANDIDATES) {
    const result = await runTrial({
      ...DEFAULT_TRIAL,
      tuning: {
        disputeTightenStep: candidate.disputeTightenStep,
        streakLoosenStep: 0.02,
        streakLoosenEvery: candidate.streakLoosenEvery,
      },
    });
    rows.push(toRow(candidate.label, candidate.disputeTightenStep, candidate.streakLoosenEvery, result));
  }
  return rows;
}
