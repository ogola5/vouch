# Vouch — Build Plan

Decision record and architecture, written to stay current as the project moves. Update it as
decisions change rather than letting it drift out of sync with the code.

## 1. Stack decisions (2026-09-17)

- **Language: TypeScript everywhere.** MCP server, mock UCP merchant, web app, and Fire TV app
  (React Native) all in one language. Matches the MCP TypeScript SDK and the
  `hello-world-fire-tv-react-native` starter the brief points at, and lets `packages/shared`'s
  Mandate/Vouch types be imported directly by every service instead of re-declared per language.
- **Monorepo via npm workspaces.** No extra tooling (Turborepo/pnpm) needed at this scale — one
  `npm install` at the root wires up all `packages/*`.
- **External accounts (AWS Bedrock, Ring developer portal): neither is set up yet.** Rather than
  block weeks 1-2 on account approval, every place that would call Bedrock or Ring is written
  against an interface first:
  - `ReasoningProvider` (`packages/reasoning`) — `explainVouch` and `adjustConfidenceThreshold`.
    Implemented today by `RuleBasedReasoningProvider` (deterministic, no model call). Add
    `BedrockReasoningProvider` once AWS access exists and swap it in at the composition root
    (`packages/mcp-server`) — no caller changes.
  - `PhysicalEvidenceProvider` (`packages/ring-integration`) — `correlateDelivery`. Implemented
    today by `MockRingProvider`, which is deterministic and *scriptable* (`scriptOutcome(orderId,
    "corroborated" | "unconfirmed")`) rather than random, so the demo can reliably show both
    states as the guardrails require. Add `RealRingProvider` once the Ring developer portal
    account and webhook are set up (Week 3 target) and swap it in the same way.
  - **There is no "package delivered" webhook, and the architecture depends on saying so.**
    Checked against Ring's published event list: the webhooks are `motion_detected`,
    `button_press`, `device_added`, `device_removed`, `device_online`, `device_offline`,
    `app_integration_added`/`removed` and `subscription_activated`/`deactivated`, HMAC-SHA256
    signed, with classification data (human / animal / vehicle) on motion. Package detection is
    a computer-vision capability, not a delivery-confirmation event you can subscribe to.
    So `RealRingProvider` will correlate a **motion event against an expected delivery window** —
    it will never receive a delivery confirmation, because none exists. State it in exactly those
    words in the writeup and the demo: *Ring gives us a motion event at the door. We correlate it
    against the window the order was expected in. That is correlation, not proof.* This is not a
    limitation to work around; it is the honest claim the guardrails in section 4 already require,
    and `MockRingProvider` is therefore a faithful stand-in rather than a weaker one.
  - **Action item, once Ring portal access is granted:** re-check
    `packages/ring-integration/src/types.ts` against the real payload. The request side
    (`order_id`, `expected_around`, `window_minutes`) survives the event-list check, but the
    response side does not yet carry what a real correlation needs — the event type and its
    classification, so a vehicle-only motion is not silently treated as a person at the door.
  - **~~Action item, do this before Week 2 (mock merchant)~~ — DONE (2026-09-17).** The UCP types
    in `packages/shared/src/ucp.ts` are no longer provisional; they are written against the
    published spec at [ucp.dev](https://ucp.dev/specification/checkout-rest/), REST binding,
    snapshot `2026-04-08`. The guess was wrong in almost every particular, which is worth
    recording because it is the strongest argument for doing this kind of check early:
    - `session_id` → `id`; the invented `created`/`updated`/`complete`/`cancelled` status enum
      → the real `incomplete`/`ready_for_complete`/`completed`/`canceled` (US spelling).
    - Money is **ISO 4217 minor units** (`2500` is $25.00), not decimals. Mandates stay in major
      units because humans author them; `toMajorUnits()` converts at the boundary. Getting this
      wrong fails closed (everything gets held), not open — see the comment in `gate.ts`.
    - A singular `payment_handler` → reverse-DNS-keyed `payment_handlers` in the `ucp` envelope,
      plus a session-level `payment.instruments`.
    - Whole objects were missing: `currency`, `buyer`, `totals`, `fulfillment`, `messages`, `links`,
      `order`, and the `ucp` envelope itself.
    - Required headers `UCP-Agent` (carrying the calling agent's profile URL), `Idempotency-Key`
      and `Request-Id` were absent entirely.
  - **Two findings from that spec read that change the architecture story:**
    1. **`ready_for_complete` is a real spec state** meaning "everything satisfied, order not
       placed". The mandate gate maps onto the `ready_for_complete → completed` transition
       exactly. Say it this way in the writeup — it is far stronger than gating an invented
       lifecycle.
    2. **UCP defines its own MCP binding** with spec-fixed tool names (`search_catalog`,
       `create_cart`, `create_checkout`, `complete_checkout`, `get_order`), advertised via
       `/.well-known/ucp` alongside REST and A2A transports. This settles the "why two services"
       question below: the merchant boundary is not an architectural preference, it is the spec
       artifact. Those are the merchant's tools; Vouch's tools are a distinct layer in front.
  - **Attribution correction, carried into the brief and README:** UCP is an open standard founded
    by Google, Shopify, Etsy, Target and Wayfair. Amazon joined its Tech Council in April 2026,
    alongside Meta, Microsoft, Salesforce and Stripe. The brief's "Amazon's own open UCP spec"
    was wrong, and the judges are Amazon product and engineering leads who would know it.
- **Alexa+ simulation: text chat, no voice.** A web chat UI stands in for the Alexa+ conversation.
  Lower risk for a recorded demo than wiring the Web Speech API; can be revisited in week 4-5 if
  there's spare time and the core loop is solid.

## 2. Architecture

```
   web-app (chat UI)                     Fire TV app (React Native)
        │  types household message            │  household dashboard view
        ▼                                       │  (completed/pending/disputed,
   orchestrator  ──(MCP client, Streamable HTTP)─┘   mandate before/after state)
   (server-side in web-app;                │
    plays the role of "the Alexa+ agent")  │
        │                                  │
        ▼                                  │
   packages/mcp-server  ◄────────────────────
     - create_mandate / get_mandate / list_mandates
     - propose_purchase   <-- THE GATE: calls evaluateProposal()
                               from packages/shared BEFORE any UCP
                               session is allowed to reach Complete
     - record_dispute     <-- drives ReasoningProvider.adjustConfidenceThreshold
     - list_vouches
        │                          │
        ▼                          ▼
   packages/mock-merchant     packages/db (SQLite)
     UCP session lifecycle:     mandates, vouches, disputes
     Create -> Update ->
     Complete | Cancel
        │
        ▼
   Vouch written (packages/shared Vouch schema), evidence filled in:
     digital  <- from the UCP session itself
     physical <- packages/ring-integration PhysicalEvidenceProvider.correlateDelivery()
     explanation text <- packages/reasoning ReasoningProvider.explainVouch()
```

**Why MCP server and mock merchant are two separate services, not one:** the brief's single
highest-leverage decision is "the mandate check must be a real gate before Complete fires — not
a caption added after the fact." Keeping them as separate network boundaries (the MCP server must
make an outbound call to the merchant to reach Complete) makes that structurally true and easy to
verify in a code walkthrough, rather than relying on internal call-order discipline inside one
process.

**This was challenged in review and survives, on better grounds than originally stated.** The
objection is fair on its own terms: a single well-tested function that every path to Complete
must call through gives the same guarantee without two services to run during a demo recording.
But it misses what the merchant boundary actually is here. UCP publishes its own MCP binding and
`.well-known/ucp` discovery document, so a conformant merchant is a *spec artifact* with a
published surface — its tool names are fixed by the specification, not chosen by us. Collapsing
it into a function inside the MCP server would delete the thing that makes "we implemented the
real published spec, both sides" checkable. Keep the split. The demo-fragility concern is real
and gets answered with process supervision, not by merging the services.

**Who plays "the Alexa+ agent"?** The brief's diagram shows Alexa+ as simulated per track
guidance. Concretely: an orchestrator running server-side inside `web-app` (a Next.js/Vite API
route), built on the Strands Agents TypeScript SDK, holds an MCP *client* connected to
`packages/mcp-server`'s Streamable HTTP endpoint. It turns the household's chat message into
tool calls (`create_mandate` for "keep detergent stocked
under $15 monthly"; `propose_purchase` when a simulated price-drop event fires). This orchestrator
is intentionally thin — it is not where the mandate gate lives; the gate lives in the MCP server
so that no other future client (Fire TV, a future real Alexa+ integration) could route around it.

**Known scope cut: household multi-user visibility.** A Vouch today is scoped to the account
that holds the mandate. The stronger version of this product is one where any household member
can see and question an agent's purchase, not just the account holder — a Receipt only one person
can read is a weaker accountability claim, since the people most affected by a bad autonomous
purchase are often not the ones who set the mandate. **This is cut for the five-week scope, not
overlooked.** It needs an identity model, per-member permissions on dispute and pause, and a
sharing story on the Fire TV surface — realistically a week on its own, and it would come out of
the adaptive loop, which is the actual differentiator. Named here as a decision, and worth one
line in the submission writeup as a known next step; it is a better answer in review than
silence, and it shows the household framing was thought through rather than assumed.

**Simulating "the world" (price drops, deliveries):** there's no live merchant with real price
changes, so week 2 needs a small demo-control surface — a panel in `web-app` (or a CLI script)
that lets you trigger "price of Brand A detergent drops to $12.49" or "price of Brand C jumps to
$27.80," which the orchestrator picks up and runs through the real gate. This is what makes step
2 and step 3 of the demo script (brief section 8) actually live rather than narrated.

## 3. Week-by-week (revised from the brief's section 7 for the stack/account decisions above)

1. **Week 1 — Mandate model.** ✅ Done this session: `packages/shared` (Mandate, Vouch, UCP
   types, `evaluateProposal` gate logic, all Zod-validated), `packages/reasoning` and
   `packages/ring-integration` interfaces + deterministic stubs. **Also done: the test suite** —
   22 tests, run by `node --test` on Node 24's native type stripping, so no test framework was
   added (`npm test`, no build step; `npm run typecheck` is the separate checking half, because
   type stripping executes types without checking them).
   - `packages/shared/test/gate.test.ts` locks down fail-closed behaviour on unrecognized and
     malformed rules, paused mandates, and the price/quantity/confidence boundaries.
   - `test/adaptive-loop.test.ts` covers the differentiating mechanism end to end: a dispute
     raises `confidence_threshold`, and the *identical* borderline proposal that passed before
     is now held. It also pins the asymmetry — one dispute (+0.07) takes four undisputed streaks
     (−0.02 each) to undo — and that the threshold can never be driven to a range where the
     mandate becomes either unusable or a no-op.
   - **Design change this forced:** `confidence_threshold` was decorative. Nothing read it —
     `evaluateProposal` never saw a confidence value, so "a dispute changes what the agent may do
     next" was not expressible, let alone testable. `PurchaseProposal` now carries a required
     `confidence`, and the gate synthesises a `below_confidence_threshold` rule. Required rather
     than optional so the fail-closed decision is forced at each call site instead of defaulted
     silently. **Reviewed and kept (2026-09-17).** The real objection is that `evaluateProposal`
     now has two jobs — mandate bounds and confidence — and a purist would split them. Keeping
     them together wins for now because the gate's contract is "may this purchase proceed", and
     a caller that had to consult two gates could consult only one. Revisit if a third concern
     wants in; at that point it becomes a pipeline of checks rather than one function, and the
     `triggeredRules` array is already the right shape to carry that.
2. **Week 2 — MCP server + mock UCP merchant + db + orchestrator on Strands.** Build
   `packages/db` (SQLite, mandates/vouches/disputes tables), `packages/mock-merchant` (real UCP
   session lifecycle, now checkable against `packages/shared/src/ucp.ts` rather than a guess),
   and `packages/mcp-server` (tools listed in the architecture diagram). The gate must run inside
   `propose_purchase`, before the call to the merchant's Complete endpoint — build a test that
   asserts an out-of-bounds proposal never reaches Complete.
   - **Decision (2026-09-17, moved forward from week 4): build the orchestrator on the Strands
     Agents TypeScript SDK from the start, not on a hand-rolled MCP client loop.** Strands
     TypeScript hit 1.0 with native MCP client support, so it replaces the loop rather than
     wrapping it, and it makes the AWS Builder mini-challenge integration a fact in week 2
     instead of a week-5 stretch goal. Deciding this in week 4, as originally written, would have
     meant rewriting the loop plus re-testing everything downstream of it.
     ```
     npm install @strands-agents/sdk
     ```
     ```ts
     import { Agent, McpClient } from "@strands-agents/sdk";
     // Vouch's MCP server speaks Streamable HTTP, so pair McpClient with
     // StreamableHTTPClientTransport from @modelcontextprotocol/sdk rather
     // than the stdio transport the Strands docs use in their example.
     const agent = new Agent({ tools: [new McpClient({ transport })] });
     ```
   - **Known risk on this decision:** Strands defaults to Amazon Bedrock (`BedrockModel`), and
     AWS access is not set up yet. It also supports Anthropic, OpenAI, Google and any Vercel AI
     SDK-compatible provider, so week 2 develops against one of those and switches the model
     provider once the $150 credit lands. That swap is a constructor argument, not a rewrite —
     which is the same interface-first reasoning used for `ReasoningProvider` and
     `PhysicalEvidenceProvider` above. **If the credit request has not been filed yet, file it
     before starting week 2**, because this decision makes it the critical path rather than a
     nice-to-have.
3. **Week 3 — Ring correlation + adaptive/dispute loop.** Swap in real Ring webhook
   (`RealRingProvider`) once portal access exists; if it's still pending, keep demoing on
   `MockRingProvider` — it's honest and scriptable, not a liability. Wire `record_dispute` to
   call `ReasoningProvider.adjustConfidenceThreshold` and persist the new threshold + a
   `Dispute` record on the Vouch.
4. **Week 4 — Conversational query layer.** Orchestrator handles "what did you buy me this
   month," "why didn't you buy the $27 one," "show me what was inferred vs. explicit" by calling
   `list_vouches`/`get_mandate` and `ReasoningProvider.explainVouch`. ~~**Decision point:**
   whether to rebuild the orchestrator on the Strands SDK.~~ **Resolved and moved to week 2** —
   the orchestrator is built on Strands from the start, so this week is query-layer work only.
5. **Week 5 — Fire TV dashboard, Bedrock swap-in (if AWS access has landed by then), demo video,
   submission writeup.** The writeup must restate the "real vs. simulated" table in the README —
   keep that table current as each provider gets a real implementation.

## 4. Guardrails carried forward from the brief (section 9) — don't relitigate these

- Never claim Ring "proves" delivery — `correlation_status` is `corroborated` /
  `unconfirmed` / `not_applicable`, never a boolean "delivered."
- Never claim to have invented agent audit trails/receipts.
- Never fabricate a precision/fit score.
- State plainly, always, which parts are real vs. simulated (see README table).

## 5. Resources & action items (from the official Devpost hackathon resources page, 2026-09-17)

Confirms the brief's section 6 in every particular that overlaps; additions and concrete
next actions below.

- **Request the $150 AWS credit now** (Devpost hackathon page has the credit request form). This
  is now the critical path, not a nice-to-have: the week-2 Strands decision means Bedrock is the
  intended model provider for the orchestrator *and* the unblock for a real
  `BedrockReasoningProvider`. Both have working fallbacks, so nothing is blocked while the request
  is pending — but every week it stays unfiled is a week of work done against a provider that has
  to be switched later.
- **AWS Builder mini-challenge covers more than Bedrock:** Bedrock, AgentCore, the Strands SDK,
  Kiro, and SageMaker are all "documented integrations" that count. Vouch's entry is the Strands
  orchestrator (week 2) plus `BedrockReasoningProvider` (week 5, or earlier if credits land).
- **Amazon Devices Builder Tools is an MCP server for the coding assistant, not for Vouch's
  runtime** — it adds Amazon device knowledge (crash analysis, perf profiling, doc search, guided
  workflows) to whatever you're coding in, i.e. it would plug into this VS Code session, not into
  `packages/mcp-server`. Requires a developer.amazon.com account to install; worth connecting once
  you have one, particularly before the Ring (week 3) and Fire TV (week 5) work, since those are
  the two pieces where device-specific guidance matters most.
- **Ring:** two more reference docs beyond `ring-api-helloworld` — "Get started with Ring"
  (configure/develop/certify/publish) and "Live apps and use cases" (what's already shipping). The
  Ring Developer community has an active Q&A section specifically useful for webhook/auth edge
  cases, matching the brief's advice to book office hours for exactly that.
- **Fire TV:** `vega-tv-interfaces-sample` ("recommended TV UI patterns for focus, i18n,
  navigation, and scrolling") is worth reading as a reference for the household dashboard's
  focus/remote navigation even though we're forking `hello-world-fire-tv-react-native`, not this
  one — the dashboard still needs correct D-pad focus behavior to feel native on a TV.
- **Fire TV starter: stay on `hello-world-fire-tv-react-native`. Do not switch to
  `react-native-multi-tv-helloworld`.** This has now been recommended twice in review and is
  wrong for this machine, so the reasoning is recorded here to stop it recurring. The two
  starters target different operating systems: `hello-world-fire-tv-react-native` is a Fire OS /
  Android TV app (`npm run android`, Android TV emulator), while `react-native-multi-tv-helloworld`
  targets **Vega OS**. The Vega Developer Tools require a native macOS or Ubuntu install —
  [Windows and WSL are explicitly unsupported and untested](https://developer.amazon.com/docs/vega/0.24/install-vega-sdk).
  Development here happens on Windows 11 with a WSL Ubuntu checkout, so switching starters would
  *create* the blocker the recommendation warns about, rather than avoid it. The current choice
  needs no Vega toolchain at all. One practical note for week 5: run the Android TV emulator from
  Android Studio on the Windows side, not inside WSL, where emulator support is awkward. If a
  Vega build ever becomes necessary, that is a native-Ubuntu-machine decision, not a starter
  swap — and Fire TV is explicitly the secondary surface here, so it should not drive the stack.
- **Bee (Wearable AI) track exists but is out of scope for Vouch** — noted for completeness, not
  a fit for a household-purchase-trust product.
