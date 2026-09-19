# CLAUDE.md — Read this before doing anything else in this repo

This file governs how you work in this repo, not just what to build. It exists because the
project has a hard deadline (Amazon "Build, Ship, Shape" hackathon, five-week build window) and
open-ended agentic capability is easy to point at the wrong thing — a real fix that wasn't asked
for, a "better" architecture that costs a rewrite, a verification pass on something already
settled. None of that is wrong in general. All of it is wrong here if it isn't the specific thing
this week needs.

## Where things are

| What | Where |
|---|---|
| What to build, week by week | `BUILD_PLAN.md` §3 |
| Constraints already decided | `BUILD_PLAN.md` §1 (stack) and §4 (guardrails) |
| Things noticed but deliberately not built | `BUILD_PLAN.md` §6 — "Noticed, not scoped" |
| Open questions awaiting a second opinion | `BUILD_PLAN.md` §7 |
| The pitch, positioning and demo script | `vouch-project-brief.md` |
| What is real vs. simulated | `README.md` — keep this table current |

If something you're about to do isn't traceable to one of those, stop before doing it, not after.

## How to run anything here

Development happens on Windows 11 against a WSL Ubuntu checkout, so commands run in **WSL bash**,
not PowerShell. Three things will waste a tool call each if you don't know them:

- **Node is nvm-managed**, so it is not on the PATH in a non-interactive shell. `bash -c "node …"`
  fails with `node: command not found`; use `bash -ic` (interactive) or source nvm first.
- The project root is `~/projects/vouch`.
- **The user's own VS Code terminal is already inside WSL Ubuntu**, sitting at
  `ogola5@DESKTOP-1669CO4:~/projects/vouch$`. So any command written *for them to paste* is bare
  bash — `npm test`, not `wsl -d Ubuntu-24.04 -- bash -ic "npm test"`. The `wsl …` prefix is only
  needed when the assistant runs a command itself through a Windows PowerShell tool. Handing them
  a PowerShell-wrapped command is a small thing that reliably wastes a round trip.

```bash
npm run typecheck   # tsc -b across the package graph, then the test sources
npm test            # tsc -b, then node --test
npm run dev:mock-merchant   # UCP merchant on :4010
npm run dev:mcp-server      # Vouch MCP server on :4020/mcp
```

## Three Node 24 constraints that are not negotiable

The project runs TypeScript directly via Node 24's native type stripping, which is *strip-only*:
it erases type annotations but does not transform syntax. Each of these has already broken the
build once. Do not reintroduce them, and do not "fix" the workarounds:

1. **No constructor parameter properties.** `constructor(private readonly x: T) {}` is a runtime
   `SyntaxError` in any file Node executes directly — which is every `npm run dev:*` entry point
   and every test. Declare the field and assign it in the constructor body.
2. **Relative imports are written with a `.ts` extension.** `rewriteRelativeImportExtensions` in
   `tsconfig.base.json` turns them into `.js` on emit. Node will not map a `./catalog.js`
   specifier onto `catalog.ts`, so changing these back breaks `npm run dev:*` outright.
3. **Tests import workspace packages by name** (`@vouch/db`), never by a relative path into
   another package's `src/`. `npm test` runs `tsc -b` first because of this. Reaching into
   `../../db/src` fails twice over: the module cannot load, and a class with a private field is
   nominally typed, so the type would not match the one in the signature you are passing it to.

## 1. Scope lock

Before starting any task, name which week-by-week item in `BUILD_PLAN.md` §3 it belongs to —
**out loud, in the first message of the task, before any tool call.** One line is enough:
`Plan item: week 2 — orchestrator on Strands.` If the task maps to nothing in §3, say that
instead and stop for confirmation.

This is stated as a visible output rather than a private check on purpose. A rule that runs
silently in an agent's head cannot be audited; a rule that has to be typed either appears or is
conspicuously missing, and the user can call it the moment it isn't there.

If it doesn't belong to one:
- If it's small and directly unblocks the current item (a missing type, a failing import), do it
  and note it.
- If it's not small, or it's an improvement you noticed rather than a blocker, **don't do it.**
  Add one line to `BUILD_PLAN.md` §6, "Noticed, not scoped", and move on. Do not implement it
  "while you're in the file."

This applies to your own ideas as much as to drift. Finding a better pattern than what's there is
not, by itself, a reason to change it mid-week.

## 2. Verification budget

Checking a real spec instead of guessing (as happened with the UCP types, and again with Ring's
actual webhook event list) is exactly the right instinct — keep doing it for anything that will
appear in the submission as a factual or technical claim. But it has a cost, and the cost should
track the stakes:

- **Verify against a primary source when:** the claim will be stated in the README, the demo
  narration, or the submission writeup as fact; or a design decision depends on an API's actual
  shape (request/response fields, auth, event types) rather than its general existence.
- **Don't re-verify when:** something is already confirmed and recorded in `BUILD_PLAN.md` with a
  date. Cite the existing note instead of re-deriving it. If you think a prior finding might be
  stale, say why, in one line, before spending a tool call re-checking it.
- **Don't chase verification depth beyond what the current task needs.** Confirming Ring's real
  event list was necessary — it changed the architecture and the honesty claims in the README.
  Reading three more articles about Ring's market share or company history would not be — it
  wouldn't change anything you're about to build. If a check isn't going to change a decision or
  a line of code, it's research for its own sake — skip it.

## 3. Architecture changes need a written trade-off before code, not after

The Strands-SDK-in-week-2 decision is the model to repeat: a real reason (avoids a week-4
rewrite, makes the AWS Builder mini-challenge a fact instead of a stretch goal), a named risk
(Bedrock default, no AWS credit yet), and a concrete mitigation (interface swap via constructor
argument, not a rewrite) — all written down *before* the `npm install`. Any change that touches
more than one package, adds a new external service, or reverses a decision already marked
"Reviewed and kept" needs that same three-part note in `BUILD_PLAN.md` first. If you can't write
the trade-off in three sentences, that's a sign to flag it and ask rather than build it.

## 4. New dependencies and new accounts get flagged, not silently added

Every new npm package, every new external account (AWS, Ring, anything else), every SDK swap is a
new thing that can fail during a live demo recording, and each one has setup cost that isn't
"free" just because the code change is small. Before adding one: one line in `BUILD_PLAN.md`
saying what it is and why the existing stack doesn't cover it. Don't add a library to save twenty
lines of code you could have written by hand in the time it takes to evaluate a new dependency.

This repo has earned its low dependency count deliberately — `node:sqlite` over `better-sqlite3`,
`node:http` over Express, `node --test` over vitest. Match that bar.

## 5. Decisions marked "Reviewed and kept" are closed, not reopened

`BUILD_PLAN.md` already uses this pattern (the `evaluateProposal` confidence design, §3 week 1).
Once a decision has that marker, don't re-litigate it on your own initiative. If genuinely new
evidence shows up (a spec detail, a failing test, something the demo script needs that the current
design can't do), name the new evidence explicitly and propose reopening it — don't just quietly
redo it because a cleaner approach occurred to you mid-task.

## 6. The MVP filter — tie every feature to the demo script

The demo script (`vouch-project-brief.md` §8: mandate → real action → real stop → real explanation
→ real adjustment) is the actual bar. Before building anything not explicitly in the week-by-week
plan, ask: does the 3-minute demo need this, or does the README's honesty table need this to stay
accurate? If neither, it's a nice-to-have — note it, don't build it. This especially applies to
polish (UI styling, edge-case handling for paths the demo doesn't exercise, extra config options)
— all real work, all worth cutting until the core loop (mandate → gate → Vouch → dispute →
adjusted mandate) is solid end to end.

## 7. Status checkpoints

After finishing a task from the week-by-week plan — not after every file — write a short status
note: what changed, what's next, any new decisions or risks. Don't run silently through multiple
plan items in one long stretch. This is what lets scope creep get caught while it's one paragraph
of wasted work instead of a day of it.

Concretely: three packages in one uninterrupted stretch is too long. One package, or one plan
sub-item, then surface.

## 8. Ambiguity: stop and ask, don't build around a guess

If a requirement is unclear and the fix would touch a meaningful amount of code (not a one-line
default), stop and ask rather than picking an interpretation and building on it. Put it in
`BUILD_PLAN.md` §7 and raise it.

The question already sitting there is exactly this kind of thing: **what actually produces the
`confidence` value on a `PurchaseProposal`?** Today the orchestrator asserts it and nothing
validates it, which means the agent grades its own homework on the one number the adaptive loop
moves. That is a design question with a blast radius across several files, so it is flagged for a
second opinion rather than silently decided.

## 9. What "done" means for a plan item

A week-by-week item is done when: it does what `BUILD_PLAN.md` §3 says, it has a test proving the
fail-closed behavior the guardrails require where that applies, and the "real vs. simulated" table
in the README stays accurate. It is not done when it's also been refactored for elegance,
generalized for a use case that isn't in scope, or extended with options nobody asked for. Ship
the narrow version; note the broader one under "Noticed, not scoped."

## 10. Never touch these without flagging it first

These claims are load-bearing for the submission's credibility and have already been gotten wrong
once each earlier in this project — do not restate or extend them without checking
`BUILD_PLAN.md`'s current, corrected language first:

- **Ring's webhook events.** No "package delivered" event exists — only `motion_detected` and
  other device-level events. Correlation against an expected delivery window, never proof.
  `correlation_status` is `corroborated` / `unconfirmed` / `not_applicable`, never a boolean.
- **UCP's origin.** An open standard founded by Google/Shopify/Etsy/Target/Wayfair; Amazon joined
  its Tech Council in April 2026 — not "Amazon's own spec".
- **Agent audit trails / receipts.** Never claim to have invented them; ACP shipped first.
- **Any fabricated precision score** (e.g. "9.5/10 strategic fit") — never introduce one; no
  rubric backs numbers like that.
- **Any specific date or quote for "when Amazon adopted MCP for commerce"** — no confirmed primary
  source exists; cite the dated UCP checkout spec instead.

Two structural properties are load-bearing in the same way, because the whole submission rests on
them being true rather than narrated. Don't weaken either without flagging it:

- **The gate runs before the order is placed**, on the UCP `ready_for_complete → completed`
  transition — and `packages/mcp-server/test/gate-before-complete.test.ts` asserts
  `completeSession` is never called for an out-of-bounds proposal. Asserting "the result said
  held" instead would pass even if the order had been placed.
- **No MCP tool completes a checkout directly.** The only routes to an order are
  `propose_purchase` (which gates) and `approve_purchase` (which requires a human's yes on an
  already-held Vouch). A test enforces this. Adding a tool that bypasses it would make the gate
  decorative.
