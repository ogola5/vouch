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
| Persistence (`packages/db`) | Real SQLite via Node 24's built-in `node:sqlite` — mandates, vouches and disputes; a tightened threshold survives a restart |
| Mock UCP merchant (`/checkout-sessions` lifecycle, `.well-known/ucp`) | Real spec-conformant shape — derived status, `Idempotency-Key`, `UCP-Agent` enforcement — with simulated checkout/payment. No payment is processed and no goods exist; completing a session mints an order id |
| Ring webhook correlation | Simulated for now (`MockRingProvider`) — real integration pending Ring developer portal access |
| Explanation + confidence-threshold adjustment | Simulated for now (`RuleBasedReasoningProvider`) — real integration pending AWS Bedrock access |
| Alexa+ | Simulated via a web chat app (per track guidance — no real Alexa+ production access needed) |
| Orchestrator ("the Alexa+ agent") | **Not built yet.** Planned as a real agent loop on the Strands Agents TypeScript SDK with a real MCP client; model provider is Bedrock once AWS credits land, another provider until then |
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
  web-app/            Simulated Alexa+ chat + household dashboard — next (Strands orchestrator)
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

Two services, in two WSL bash terminals (not Windows PowerShell):

```bash
npm install
npm run dev:mock-merchant   # UCP merchant on :4010
npm run dev:mcp-server      # Vouch MCP server on :4020/mcp
```

Trigger a price change the agent has to react to:

```bash
curl -X POST http://127.0.0.1:4010/demo/price \
  -H 'Content-Type: application/json' \
  -d '{"product_id":"detergent-brand-a","price":12.49}'
```

## Checks

**Requires Node 24+.** Tests are plain `.ts` files executed directly by `node --test` using
Node 24's native type stripping, so there is no test framework, bundler or transpile step —
which is why there is no vitest/jest dependency here.

```bash
npm run typecheck   # tsc -b across the package graph, then the test sources
npm test            # 61 tests
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
