import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { costOfTightening, lateHarmReduction, runTrial } from "./simulate.ts";
import { runSweep } from "./sweep.ts";
import { meanPricePaid, restockSummary, runAutoBuySweep, runRestockTrial, type PolicyMetrics } from "./restock.ts";

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

const restock = runRestockTrial();
writeFileSync(resolve(PACKAGE_ROOT, "results", "restock.json"), `${JSON.stringify(restock, null, 2)}\n`, "utf8");
const s = restockSummary(restock);
const autoBuySweep = runAutoBuySweep();
writeFileSync(resolve(PACKAGE_ROOT, "results", "autobuy-sweep.json"), `${JSON.stringify(autoBuySweep, null, 2)}\n`, "utf8");
const row = (label: string, m: PolicyMetrics, q: number) =>
  `  ${label.padEnd(30)} ${String(m.stockoutDays).padStart(7)}   ${m.meanStockDays.toFixed(1).padStart(6)}   ` +
  `${String(m.packsBought).padStart(6)}   ${String(m.earlyArrivals).padStart(6)}   ${q.toFixed(1).padStart(5)}`;

console.log(`
Vouch — restocking from a forecast vs a calendar
${"=".repeat(60)}
${restock.config.households} households · ${restock.itemYears.toLocaleString()} item-years · seed ${restock.config.seed}

                                 days out  stock    packs   early   asks/
                                 of stock  (days)   bought  arrive  hh/wk
${row("forecast, asks once per pack", restock.forecast, s.forecast.questionsPerHouseholdWeek)}
${row("forecast, never asks", restock.forecastNoQuestions, 0)}
${row("forecast, asks weekly", restock.forecastWeekly, s.forecastWeekly.questionsPerHouseholdWeek)}
${row("calendar, household's interval", restock.calendarStated, 0)}
${row("calendar, monthly", restock.calendarMonthly, 0)}
${row("Auto Buy at a target price", restock.autoBuy, 0)}

Mean price paid (1.00 = usual): forecast ${meanPricePaid(restock.forecast).toFixed(3)} · Auto Buy ${meanPricePaid(restock.autoBuy).toFixed(3)}
Packs the household had to order by hand after running out: forecast ${restock.forecast.boughtByHousehold.toLocaleString()} · Auto Buy ${restock.autoBuy.boughtByHousehold.toLocaleString()}

Auto Buy depends on how often prices drop, so the whole curve:

  deal every   days out of stock        stock in house (days)   price paid
               Auto Buy   forecast      Auto Buy   forecast       Auto Buy   forecast
${autoBuySweep
  .map(
    (r) =>
      `  ~${String(r.dealEveryDays).padStart(2)} days    ${String(r.autoBuy.stockoutDays).padStart(8)}   ${String(r.forecast.stockoutDays).padStart(8)}      ` +
      `${r.autoBuy.meanStockDays.toFixed(1).padStart(8)}   ${r.forecast.meanStockDays.toFixed(1).padStart(8)}       ` +
      `${r.autoBuy.meanPricePaid.toFixed(3).padStart(8)}   ${r.forecast.meanPricePaid.toFixed(3).padStart(8)}`
  )
  .join("\n")}

Forecast accuracy: off by ${restock.forecastAccuracy.meanAbsErrorDays.toFixed(1)} days on average; the real
days-left fell inside its 80% range ${(restock.forecastAccuracy.coverage80 * 100).toFixed(1)}% of the time.
${"=".repeat(60)}
`);
