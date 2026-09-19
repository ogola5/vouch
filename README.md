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
| Mandate model + gate logic (`packages/shared`) | Real, with 22 tests covering fail-closed behaviour and the dispute → threshold → changed-outcome loop |
| MCP server (mandate gate as an actual request-path check) | Real, not yet built |
| Mock UCP merchant (`/checkout-sessions` lifecycle, `.well-known/ucp`) | Real spec-conformant shape, simulated checkout/payment |
| Ring webhook correlation | Simulated for now (`MockRingProvider`) — real integration pending Ring developer portal access |
| Explanation + confidence-threshold adjustment | Simulated for now (`RuleBasedReasoningProvider`) — real integration pending AWS Bedrock access |
| Alexa+ | Simulated via a web chat app (per track guidance — no real Alexa+ production access needed) |
| Orchestrator ("the Alexa+ agent") | Real agent loop on the Strands Agents TypeScript SDK with a real MCP client; model provider is Bedrock once AWS credits land, another provider until then |
| Fire TV dashboard | Real React Native app hitting the same API as the web app |

## Repo layout

```
packages/
  shared/            Mandate, Vouch, UCP types + the mandate gate (evaluateProposal) — done
  reasoning/          ReasoningProvider interface + RuleBasedReasoningProvider stub — done
  ring-integration/   PhysicalEvidenceProvider interface + MockRingProvider stub — done
  db/                 SQLite persistence for mandates/vouches/disputes — next
  mock-merchant/       UCP-shaped session lifecycle backend — next
  mcp-server/          MCP server; the one place allowed to gate a purchase — next
  web-app/             Simulated Alexa+ chat + household dashboard — next
  fire-tv-app/         React Native household surface — week 5
```

## Repo layout additions

```
test/                adaptive-loop.test.ts — cross-package dispute/threshold/gate integration test
packages/shared/test/ gate.test.ts — the fail-closed mandate gate suite
```

## Getting started (run in your WSL bash terminal, not Windows PowerShell)

**Requires Node 24+.** Tests are plain `.ts` files executed directly by `node --test` using
Node 24's native type stripping, so the suite needs no test framework, no bundler and no
transpile step — which is why there is no vitest/jest dependency here.

```bash
npm install
npm run typecheck   # tsc -b across the package graph, then the test sources
npm test            # 22 tests, no build step required
```

Note that type stripping executes types without checking them, so `npm test` passing does not
imply the code typechecks — run both.
# vouch
