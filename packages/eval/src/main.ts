import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { costOfTightening, lateHarmReduction, runTrial } from "./simulate.ts";
import { runSweep } from "./sweep.ts";

/**
 * Runs the trial and commits the result, so the numbers in the README are
 * re-derivable rather than asserted. `test/claims.test.ts` reads this file
 * back and fails if a published figure has drifted from it.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(PACKAGE_ROOT, "results", "trial.json");

const result = await runTrial();

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");

const decisions = result.adaptive.totalOpportunities;
const reduction = lateHarmReduction(result);
const cost = costOfTightening(result);

const sweep = await runSweep();
writeFileSync(
  resolve(PACKAGE_ROOT, "results", "sweep.json"),
  `${JSON.stringify(sweep, null, 2)}\n`,
  "utf8"
);

console.log(`
Vouch — adaptive loop trial
${"=".repeat(60)}
${result.config.households} households · ${decisions.toLocaleString()} purchase decisions · seed ${result.config.seed}

Both arms saw identical histories. The only difference is whether a dispute
was allowed to move the mandate's confidence threshold.

                           adaptive     static
  unwanted, completed      ${String(result.adaptive.unwantedCompleted).padStart(8)}   ${String(result.static.unwantedCompleted).padStart(8)}   <- the harm
  wanted, held             ${String(result.adaptive.wantedHeld).padStart(8)}   ${String(result.static.wantedHeld).padStart(8)}   <- the cost
  wanted, completed        ${String(result.adaptive.wantedCompleted).padStart(8)}   ${String(result.static.wantedCompleted).padStart(8)}
  mean final threshold     ${result.adaptive.meanFinalThreshold.toFixed(3).padStart(8)}   ${result.static.meanFinalThreshold.toFixed(3).padStart(8)}

Late history (final quarter, ${result.lateHarm.opportunities.toLocaleString()} decisions), which is where a
loop that learns should show up:

  unwanted completions     ${String(result.lateHarm.adaptive).padStart(8)}   ${String(result.lateHarm.static).padStart(8)}
  reduction                ${reduction.toFixed(1).padStart(7)}%

What it cost: ${cost} more wanted purchases held for approval across the run.
${"=".repeat(60)}

The trade-off curve. Every setting buys its harm reduction with wanted
purchases held, so the frontier matters more than any single number:

  tuning                       harm cut   extra held   wanted completed   final thr
${sweep
  .map(
    (r) =>
      `  ${r.label.padEnd(26)} ${`${r.harmReduction.toFixed(1)}%`.padStart(8)}   ` +
      `${String(r.extraWantedHeld).padStart(10)}   ${`${r.wantedCompletionRate.toFixed(1)}%`.padStart(16)}   ` +
      `${r.meanFinalThreshold.toFixed(3).padStart(9)}`
  )
  .join("\n")}
${"=".repeat(60)}
written to ${OUT}
`);
