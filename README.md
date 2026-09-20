# Vouch

**The trust layer for what your AI agent actually did — not just what it says it will do.**

Amazon Developer Hackathon 2026 ("Build, Ship, Shape") — primary track **Alexa+**, secondary
integrations **Ring** and **Fire TV**, AWS Builder mini-challenge for reasoning/explanation.

See [`vouch-project-brief.md`](./vouch-project-brief.md) for the full pitch, the competitive
positioning against KYA/ACP/UCP, and the guardrails on what never to claim. See
[`BUILD_PLAN.md`](./BUILD_PLAN.md) for the architecture, stack decisions, and week-by-week plan.

## A note on UCP, since the submission will be read by Amazon engineers

UCP (Universal Commerce Protocol) is an **open standard**, not an Amazon specification. It was
founded by Google, Shopify, Etsy, Target and Wayfair; Amazon, Meta, Microsoft, Salesforce and
Stripe joined the UCP Tech Council in April 2026. Vouch is not "a reference implementation of
Amazon's spec" — it is a household trust layer built on the open standard Amazon has just
committed to. [`packages/shared/src/ucp.ts`](./packages/shared/src/ucp.ts) is written against
the published [REST binding](https://ucp.dev/specification/checkout-rest/), snapshot `2026-04-08`.

Worth knowing for the architecture: UCP also defines an **MCP binding** with spec-fixed tool
names (`search_catalog`, `create_cart`, `create_checkout`, `complete_checkout`, `get_order`),
advertised through `/.well-known/ucp`. Those are the *merchant's* tools. Vouch's own MCP tools
(`create_mandate`, `propose_purchase`, …) are a distinct layer sitting in front of them — which
is the clearest statement of what this project actually is.

## What's real vs. simulated (keep this current — required for the submission writeup)

| Piece | Status |
|---|---|
| Mandate model + gate logic (`packages/shared`) | Real, with tests covering fail-closed behaviour and the dispute → threshold → changed-outcome loop |
| MCP server (mandate gate as an actual request-path check) | Real, over Streamable HTTP. The gate runs on the `ready_for_complete → completed` transition; a held purchase leaves a genuine UCP session parked one call short of an order |
| Separation of agent authority from household authority | Real and structural. The agent's MCP tools contain nothing that can widen its own authority — no `approve_purchase`, no mandate editing, no direct checkout. Those live on a separate `/household` surface a model never sees. Not authenticated yet: it binds to localhost |
| Orchestrator ("the Alexa+ agent"), model-side | Real Strands agent on Gemini, driving the real tools. Verified reaching the gate; its behaviour under refusal is still being measured |
| Persistence (`packages/db`) | Real SQLite via Node 24's built-in `node:sqlite` — mandates, vouches and disputes; a tightened threshold survives a restart |
| Mock UCP merchant (`/checkout-sessions` lifecycle, `.well-known/ucp`) | Real spec-conformant shape — derived status, `Idempotency-Key`, `UCP-Agent` enforcement — with simulated checkout/payment. No payment is processed and no goods exist; completing a session mints an order id |
| Ring webhook correlation | **Receiver real, deliveries simulated.** HMAC-SHA256 verification over the raw body, event parsing, classification (human/animal/vehicle) and time-window correlation are all real and tested, and run with `RING_MODE=real`. What has *not* happened is a delivery from Ring's servers: that needs partner account linking, which requires a sign-in and user-identity system this product deliberately does not have (`BUILD_PLAN.md` §7). `MockRingProvider` remains the default. Note that even a real webhook gives correlation against an expected window, never proof — Ring publishes no package-delivered event |
| Explanation + confidence-threshold adjustment | Simulated for now (`RuleBasedReasoningProvider`) — real integration pending AWS Bedrock access |
| Alexa+ | Simulated via a web chat app (per track guidance — no real Alexa+ production access needed) |
| Alexa+ as a *real add-on* (MCP Toolkit) | **Blocked, not skipped.** The Alexa AI CLI sits behind a private AWS CodeArtifact registry gated on Solutions Architect onboarding, and Alexa+ has no African marketplace. Attempted and recorded in `BUILD_PLAN.md` §7; the track explicitly permits simulating via a web app |
| Fire TV dashboard | Real React Native app hitting the same API as the web app |

## Repo layout

```
packages/
  shared/             Mandate, Vouch, UCP types + the mandate gate (evaluateProposal) — done
  reasoning/          ReasoningProvider interface + RuleBasedReasoningProvider stub — done
  ring-integration/   PhysicalEvidenceProvider interface + MockRingProvider stub — done
  db/                 SQLite persistence for mandates/vouches/disputes — done
  mock-merchant/      UCP session lifecycle + /.well-known/ucp + demo price control — done
  mcp-server/         MCP server; the one place allowed to gate a purchase — done
  web-app/            Console: dashboard + demo controls over an MCP client — done
                      (the Strands chat orchestrator slots in beside the bridge, still to come)
  fire-tv-app/        React Native household surface — week 5

test/
  adaptive-loop.test.ts            the dispute/threshold/gate loop as pure logic
  adaptive-loop-persisted.test.ts  the same loop through the real gate, session and database
packages/shared/test/       gate.test.ts — the fail-closed mandate gate suite
packages/db/test/           store.test.ts — persistence, and the dispute transaction
packages/mock-merchant/test/ lifecycle.test.ts — UCP status machine, over HTTP
packages/mcp-server/test/   gate-before-complete.test.ts — the gate is never bypassed
                            end-to-end.test.ts — the demo script across two network hops
```

## Running it

Three services. One terminal each, or `npm run dev:all` to start all three at once:

```bash
npm install
npm run dev:mock-merchant   # UCP merchant       :4010
npm run dev:mcp-server      # Vouch MCP server   :4020/mcp
npm run dev:web-app         # Console (open this) :4030
```

Then open **http://127.0.0.1:4030** and walk the demo script:

1. **The world** — drop Brand A to `12.49`.
2. **Mandates** — create the detergent mandate (one button). Watch the confidence threshold.
3. **Propose a purchase** — Brand A at confidence `0.92` → it buys, and a Vouch appears.
4. Propose **Brand C** ($27.80) → **held**, with `price > max_price` shown as the rule that
   stopped it, and no order id. The checkout session really reached `ready_for_complete` and
   stopped there.
5. On the completed Vouch, click **"I didn't want that"** → the threshold moves 0.85 → 0.92.
6. Propose Brand A again at confidence `0.88` → now **held**, on `below_confidence_threshold`.
   Same purchase, same price. The agent's authority changed, not the product.

The console calls the same MCP tools an agent calls — it has no logic of its own, so what it
shows is what an agent would see.

## Checks

**Requires Node 24+.** Tests are plain `.ts` files executed directly by `node --test` using
Node 24's native type stripping, so there is no test framework, bundler or transpile step —
which is why there is no vitest/jest dependency here.

```bash
npm run typecheck   # tsc -b across the package graph, then the test sources
npm test            # 71 tests
```

Two things that follow from running TypeScript directly, both of which cost time to rediscover:

- **Type stripping executes types without checking them**, so `npm test` passing does not imply
  the code typechecks. Run both.
- **Stripping is strip-only — it erases annotations but does not transform syntax.** So
  constructor parameter properties (`constructor(private readonly x: T)`) are a runtime
  `SyntaxError`, and relative imports are written with a `.ts` extension
  (`rewriteRelativeImportExtensions` turns them into `.js` on emit). `npm test` runs `tsc -b`
  first, because tests import workspace packages by name rather than reaching into another
  package's `src/`.
