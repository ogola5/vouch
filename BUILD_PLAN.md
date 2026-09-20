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
    - **Persistence: Node 24's built-in `node:sqlite`, not `better-sqlite3` (2026-09-19).** Same
      reasoning that picked `node --test` over a test framework — the project is already on Node 24
      for native type stripping, so use what that buys. `better-sqlite3` is a native module needing a
      compile toolchain at install time, which on a Windows/WSL checkout is a reliable source of
      "works on my machine". `DatabaseSync` is unflagged on Node 24 and was verified working here
      before the package was written.
    - **Three constraints that Node 24's type stripping imposes on all source, learned the hard way
      in week 2 (2026-09-19).** Stripping is *strip-only*: it erases type annotations but does not
      transform syntax. That has consequences which cost real time to rediscover, so they are
      recorded here rather than left to be re-hit in week 4:
      1. **Constructor parameter properties are a runtime `SyntaxError`.** `constructor(private
        readonly merchant: Merchant) {}` fails with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` in any file
        Node executes directly — which includes every `npm run dev:*` entry point and every test.
        Declare the field and assign it in the constructor body instead. The whole project avoids
        the shorthand.
      2. **Relative imports are written with a `.ts` extension**, with
        `rewriteRelativeImportExtensions` in `tsconfig.base.json` turning them into `.js` on emit.
        Node does not map a `./schema.js` specifier onto `schema.ts` the way ts-node or tsx would,
        so `node src/main.ts` fails outright the moment a package has a real (non-type-only) import
        between two of its own files. Week 1 never hit this because every relative import it had was
        `import type` and was erased before Node saw it; `npm run dev:mock-merchant` and
        `npm run dev:mcp-server` were both broken the first time they were run.
      3. **Week 1's "`npm test` needs no build step" is reversed.** Tests now import workspace
        packages by name (`@vouch/db`) rather than reaching into another package's `src/`, and
        `npm test` runs `tsc -b` first. Two independent reasons force this: consequence (2) above
        means a package's source cannot be loaded from `src/` at all once it has internal value
        imports, and a class with a private field is *nominally* typed — a `VouchStore` built from
        `../../db/src` is not assignable to the `@vouch/db` `VouchStore` in `VouchService`'s
        signature. Testing what actually ships is the better default anyway;
        `--enable-source-maps` keeps failures pointing at TypeScript line numbers.
    - **Confidence thresholds are rounded to 4 decimal places, not just clamped (2026-09-19).**
      `0.85 + 0.07` is `0.9199999999999999` in binary floating point, and repeated adjustments
      compound it. Harmless for the gate's comparison, but the value is persisted, returned over MCP
      and shown on the Fire TV surface as the mandate's before/after state — "your threshold is now
      0.9199999999999999" undercuts the one screen the demo is built to land. 4 places is far finer
      than the smallest 0.02 step, so no decision changes.

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

    **Two surfaces over one service, and the rule that decides which (2026-09-19).** The MCP tool
    list is what the AGENT may do. A separate HTTP surface, `/household/*` in
    `packages/mcp-server/src/household.ts`, is what the HOUSEHOLD may do. The console speaks both;
    a model only ever sees the first. The dividing rule, which is worth stating in exactly these
    words in a walkthrough:

    > **The agent may do anything that cannot increase its own authority.**

    So `record_dispute` is on both surfaces — a dispute only ever tightens a mandate, so an agent
    able to forge one could only harm itself, and relaying "I didn't want that" out of a
    conversation is a legitimate thing for an agent to do. `pause_mandate` likewise only ever
    removes authority. Whereas `approve_purchase` and mandate editing are household-only: approval
    turns a refusal into an order, and raising `max_price` lifts the ceiling the gate checks
    against. An agent holding either could grant itself whatever the gate had just denied.

    **This reverses an earlier decision and the reason matters.** `approve_purchase` *was* an MCP
    tool, and the system prompt told the model not to approve its own held purchases. A live run
    showed why that is not enough: the resulting Vouch records `approved_by_household`, so an
    agent doing it would write a statement into the household's record that is **false** — the one
    lie this whole project exists to make impossible. A prompt is a request; a missing tool is a
    guarantee. The same reasoning already kept `complete_checkout` off the toolset; this just
    applies it consistently.

    **Risk accepted:** the household surface has no authentication. It binds to 127.0.0.1 and is
    trusted because it is local. A real deployment needs an identity model — which is exactly
    where the scope cut below would begin.

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
    2. **Week 2 — MCP server + mock UCP merchant + db + orchestrator on Strands.** ✅ **Three of the
      four done this session; the Strands orchestrator is the one piece outstanding.** Built:
      `packages/db` (SQLite via Node 24's built-in `node:sqlite`), `packages/mock-merchant` (UCP
      session lifecycle, `/.well-known/ucp`, demo price control) and `packages/mcp-server` (nine
      tools, Streamable HTTP). 61 tests pass, typecheck clean, both services boot and talk to each
      other over HTTP.
      - **The gate's position in the lifecycle, decided and worth defending in a walkthrough.** The
        session is created and driven to `ready_for_complete` FIRST, and the gate runs on the
        `ready_for_complete -> completed` transition. Refusing earlier would be easier and much
        weaker evidence: "we never asked" proves nothing about whether the check works. Because the
        gate runs last, a held purchase leaves a genuine UCP session parked at the spec state
        meaning *every requirement satisfied, order not placed*, with its id on the Vouch — so the
        demo can show the session sitting one call short of an order. `packages/mcp-server/test/
        gate-before-complete.test.ts` asserts `completeSession` is never dialled, which is the claim;
        asserting the result said "held" would have passed even if the order had been placed.
      - **The price the gate compares is read off the merchant's session, never taken from the
        caller.** An agent that could name its own price for the bounds check could authorise
        anything. Brand is still caller-asserted, because UCP's item shape carries id/title/price and
        no brand attribute — noted in `service.ts`, and it only feeds the softer `new_brand` rule.
      - **`max_price` means UNIT price, not order total.** The brief's own demo buys 2 units at
        $12.49 against a $15 mandate, so unit price is what the mandate language means there;
        `quantity > N` is what bounds total exposure. Genuine ambiguity, resolved in one place.
      - **New tool not in the original list: `approve_purchase`.** A held Vouch needed a way to
        become an order once the household says yes, otherwise `ready_for_complete` is a dead end.
        It deliberately does not re-run the gate — `requires_approval_if` means the purchase needs a
        human, and this is that human — but it only works from `PendingApproval`, so it cannot be
        used to skip the gate on a fresh proposal. There is still no tool that completes a checkout
        directly, and a test asserts that stays true.
      - **Undisputed streaks are counted at completion, with no dispute window.** A real deployment
        would want a settling period before an action counts as trusted. Named here rather than
        glossed; it is a one-line caveat in the writeup, not a hidden shortcut.
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
        // ~~pair McpClient with StreamableHTTPClientTransport by hand~~ — NOT
        // NEEDED. Verified against @strands-agents/sdk 1.18.0 on 2026-09-19:
        // McpClient takes a `url` and builds the Streamable HTTP transport
        // itself. The `transport` option remains for what that misses (stdio).
        const client = new McpClient({ url: "http://127.0.0.1:4020/mcp" });
        const agent = new Agent({ tools: await client.listTools() });
        ```
      - **Step 1 DONE (2026-09-19): `packages/orchestrator`, model-free.**
        `connectVouchToolset()` connects, lists, and pins the nine tool names.
        Five tests assert the connection state, the exact tool list, that the
        server's instructions arrive (the only in-band statement of how Vouch
        expects to be used), and that an out-of-bounds purchase still reads as
        `held_for_approval` *through the SDK's own result wrapping*. That last
        one earns its place: a client that reshaped or swallowed a refusal
        would let an agent proceed as though the purchase had succeeded, and
        no test in `mcp-server` would catch it.
      - **Deviation from §2, recorded per `CLAUDE.md` §3.** §2 puts the
        orchestrator "server-side inside `web-app` (a Next.js/Vite API route)".
        It is its own package instead. Reason: we use neither Next nor Vite,
        and Strands pulls in ~35 packages including the Bedrock runtime —
        keeping that out of the process that serves the console means the
        dashboard still runs when the model provider is misconfigured. Risk:
        one more package. Mitigation: `web-app` imports `@vouch/orchestrator`
        when the chat arrives; no protocol or tool changes.
      - **Flagged per §4 — Strands brings a second `zod`.** It resolves
        `zod@4.6.5` nested under `packages/orchestrator` while the rest of the
        repo is on `zod@3.25.76`, so npm cannot hoist it. Harmless today
        because no Zod schema crosses that boundary. It will matter the moment
        we use Strands' `ZodTool` or structured output, and the two majors are
        not interchangeable. Recorded now so it is not a surprise then.
      - **Useful for later:** `McpClient` also accepts `auth` (OAuth
        client-credentials) and `headers`. If the Alexa+ add-on path in §7 ever
        unblocks and `mcp-server` grows the OAuth 2.1 layer it requires, the
        orchestrator reaches it through `auth` rather than a rewrite.
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

    ## 6. Noticed, not scoped

    Real improvements spotted while working, deliberately not built. Per `CLAUDE.md` §1, anything
    noticed mid-task that isn't a blocker for the current week-by-week item lands here as one line
    rather than getting implemented "while you're in the file". Revisit only when a week's plan
    actually calls for it, or after the core loop is solid end to end.

    - The mock merchant's `DEMO_TAX_RATE` is a flat 8.75% with no per-destination logic. Fine for the
      demo; wrong for anything real.
    - `VouchService` hardcodes `DEMO_HOUSEHOLD` (email + shipping destination). A real system looks
      this up per account, which is also where the cut household multi-user story (§2) would start.
    - `MockRingProvider.scriptOutcome` keys on `order_id`, which doesn't exist until the order does,
      so scripting a corroborated outcome in advance needs an interception rather than a
      pre-registration. Workable, slightly awkward — see `end-to-end.test.ts`.
    - `UcpTotal.type` is a loose `string` rather than a closed enum, pending a read of the UCP
      OpenAPI schema. Deliberate: guessing a closed set here would reintroduce the exact failure the
      ucp.ts rewrite fixed.
    - Declaration files emit `.ts` relative specifiers under `rewriteRelativeImportExtensions` while
      the JavaScript correctly emits `.js`. TypeScript resolves this fine and typecheck passes, so it
      costs nothing today; it would matter only if a non-TypeScript consumer ever read `dist/`.
    - **An approved purchase and a purchase allowed by a raised limit look identical in the
      console (noticed 2026-09-19).** Both show `Complete` with the original triggered rule still
      attached. The Vouch *data* distinguishes them — `approved_by_household` is in
      `decision.reason` — but the UI does not surface it. Worth closing, because "the record is
      unambiguous" is the product's central claim and this is the one place it currently is not.
      Small: a badge on the vouch card.
    - **`react-native-multi-tv-app-sample` is a third Fire TV starter, distinct from the
      `react-native-multi-tv-helloworld` that §5 rejected (noted 2026-09-19).** The Devpost resources
      page calls it "the most complete starter" and lists **Android TV** among its targets, not Vega
      alone — so §5's rejection reasoning (Vega Developer Tools need native macOS or Ubuntu; Windows
      and WSL are unsupported) may not apply to it. Not acted on: Fire TV is the secondary surface,
      it is week-5 work, and the brief is explicit about not over-investing there. Worth five minutes
      before week 5 begins, not now.

    ## 7. Open questions — flagged for a second opinion, not silently decided

    Per `CLAUDE.md` §8: requirements that are genuinely unclear and whose resolution would touch a
    meaningful amount of code. Raise these rather than picking an interpretation and building on it.

    - **What actually produces the `confidence` value on a `PurchaseProposal`? (opened 2026-09-19)**
      `evaluateProposal` compares it against the mandate's `confidence_threshold`, and the adaptive
      loop exists to move that threshold — so this number is the single most load-bearing input in
      the system. Today the orchestrator asserts it and nothing validates it, which means the agent
      effectively grades its own homework on the one value its authority depends on. Options, none
      chosen: derive it from observable signals (price delta vs. history, brand match, recency of a
      prior purchase) rather than letting the model state it; have the `ReasoningProvider` produce it
      so the Bedrock swap covers it; or keep it caller-asserted and say so plainly in the writeup as
      a known limitation. Blast radius is several files, so it wants a decision before week 4's query
      layer leans on it.
    - **Is `brand` on a proposal trustworthy? (opened 2026-09-19)** Same shape of problem, smaller
      stakes. UCP's item schema carries `id`, `title` and `price` but no brand attribute, so the
      `new_brand` rule is evaluated against a caller-supplied string. Price is already read off the
      merchant's session precisely so the agent cannot name its own; brand is the remaining gap.

    - **Simulate Alexa+, or become a real Alexa+ add-on? (opened 2026-09-19 — needs a decision
      before the orchestrator is built)**

      **The finding.** The Devpost resources page points at an **Alexa+ MCP Toolkit** that neither
      the brief nor §5 of this plan knew about. Verified against the primary source today:
      [overview](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html) and
      [quickstart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html).
      An MCP server can be deployed as a genuine Alexa+ add-on and **tested in a web simulator, with
      no physical device**. This reopens a decision §1 recorded as settled ("Alexa+ simulation: text
      chat, no voice"), so it is flagged rather than acted on.

      **What we already satisfy:** Streamable HTTP transport, and an MCP server defining tools.

      **What it would additionally cost** — all infrastructure, none of it the differentiator:
      - **OAuth 2.1 authorization code flow with PKCE (S256)**, a `401` without a `WWW-Authenticate`
        header for unauthenticated requests, and Protected Resource Metadata published at
        `/.well-known/oauth-authorization-server`. `packages/mcp-server` has no auth at all today.
        This is the single largest item and the main reason this is a question rather than a plan.
      - A **public remote URL** (cloudflared or similar tunnel in development).
      - **Round-trip latency under 500 ms** — currently unmeasured.
      - The **Alexa AI CLI** (`alexa-ai configure` / `new mcp` / `deploy`), an `addon.json`, 3-4
        example phrases, privacy and terms URLs, icons in six sizes and a 600x900 carousel image.
      - Optionally `@modelcontextprotocol/ext-apps` (MCP Apps) for in-conversation visual output.

      **Why it might still be worth it.** The judging criteria lead with "real MCP server … not a
      mockup" (brief §10). "This runs as an actual Alexa+ add-on, here it is in the simulator" is a
      materially stronger claim than "we simulated Alexa+ with a web chat UI" — and the track
      explicitly permits the weaker one, so nobody is forced to do this and most entrants will not.

      **Why it is not a straight win.** It partly obsoletes the Strands orchestrator: if real Alexa+
      is the agent, it picks our tools and the stand-in orchestrator has less to do. It also spends a
      week on auth and asset plumbing during the window where the adaptive loop — the actual
      differentiator — needs a visible surface.

      **The three options, stated so a choice can be made rather than drifted into:**
      - **A — Keep the recorded plan.** Strands orchestrator plus a web chat UI standing in for
        Alexa+. Self-contained, no new accounts, lowest risk, weakest claim.
      - **B — Go for the real add-on.** Strongest claim, highest risk, and the OAuth work is
        load-bearing before anything is demonstrable.
      - **C — Hybrid.** Real Alexa+ add-on for the conversational half (ask, explain, dispute), and
        keep a Strands agent for the half Alexa+ structurally cannot do: watching for a price drop
        and proposing a purchase with no human in the loop. Vouch's demo needs an agent that acts
        *unprompted*; Alexa+ is conversational and would not. This also keeps the AWS Builder
        mini-challenge entry intact.

      **Recommended next action, whichever is chosen: a timeboxed spike, not a commitment.** Install
      the Alexa AI CLI and get as far as `alexa-ai new mcp` against the existing server to find out
      what the onboarding actually demands. The OAuth requirement is the thing that could eat a week;
      it should be discovered in an afternoon, before the orchestrator is built on either assumption.

      **DECIDED 2026-09-19: Option B — build the real Alexa+ add-on.** Chosen by the project owner
      after the trade-off above was written. The recommendation had been C; B was chosen and is not
      reopened. Note that C stays reachable without rework — a Strands agent driving autonomous
      price-drop proposals can be added later against the same MCP tools, because the gate lives in
      `packages/mcp-server` and not in any client.

      **Verified prerequisites** (sources: [set up your development
      environment](https://developer.amazon.com/docs/alexaplus/add-ons/set-up-your-development-environment.html),
      [quickstart](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html)):
      - Alexa developer account (free, an existing Amazon account works) **and an AWS account with an
        IAM user with programmatic access**. Note this promotes AWS from "critical path for Bedrock"
        to a hard blocker for the primary track itself.
      - Alexa App profile completed, including phone number and address.
      - Node.js 24+ — already satisfied (24.21.0).
      - `npm install -g @alexa-ai/cli`, then `alexa-ai configure` (browser LWA OAuth, credentials
        land in `~/.alexa-ai/credentials`).
      - **OS: macOS Sierra or higher, or Ubuntu.** WSL Ubuntu is not named either way; treat as a
        small unknown to settle in the spike. This is the same class of constraint that ruled out the
        Vega toolchain in §5, so it is worth checking early rather than assuming.

      **The risk that could sink this option, to check FIRST (open, 2026-09-19):** the docs require
      the account's **preferred marketplace and device language to be set to an Alexa+ supported
      marketplace/locale**, and do not enumerate which those are. Alexa+ has rolled out US-first. If
      the owner's Amazon marketplace is not supported, Option B may be unavailable regardless of
      effort. This is a five-minute check and it gates everything else in B — do it before installing
      anything.

      **B PAUSED PENDING ELIGIBILITY, 2026-09-19 — the country list, now verified.** Raised by the
      project owner and confirmed against Amazon's own newsroom
      ([Alexa+ international launch](https://www.aboutamazon.com/news/devices/alexa-plus-international-launch),
      [TechCrunch 2026-09-16](https://techcrunch.com/2026/09/16/amazon-launches-alexa-in-india-with-hindi-support/)).
      Alexa+ is live in: **US, UK, Canada, Mexico, Brazil, Germany, Austria, Spain, Italy, France,
      Australia, and India** (India added 2026-09-16). Amazon's stated plan is "10+ additional
      countries in 2027". **No African market appears on the list or in the near-term plan.**

      This is evidence neither party had when B was chosen, so revisiting it is §5-compliant rather
      than relitigation. The OAuth 2.1 work is **not** started until eligibility is settled: it is
      the expensive item, and no amount of it fixes an ineligible marketplace.

      **The distinction that decides this, and is not yet answered.** The docs gate on the account's
      **marketplace**, not on the developer's physical location. Amazon operates **no Kenya
      marketplace**, so a Kenyan customer's account typically already sits on `amazon.com` (US) with
      a local delivery address. "The owner is in Kenya" therefore does not by itself imply "the
      marketplace is unsupported" — two different facts, and only one of them gates the toolkit.
      Unknown as of this entry; the owner's reported marketplace setting was not captured.

      **Settle it with the CLI, not with more reading.** The onboarding itself reports eligibility:
      ```
      npm install -g @alexa-ai/cli
      alexa-ai configure          # browser LWA login; writes ~/.alexa-ai/credentials
      ```
      Ten minutes, no project code touched, no OAuth written. `@alexa-ai/cli` is a **global developer
      tool, not a runtime dependency** — flagged per `CLAUDE.md` §4, but it never enters any
      `package.json` and cannot affect the demo.

      **If eligibility fails, the fallback costs nothing in track standing.** The Alexa+ track states
      outright: *"You can simulate an Alexa+ experience using your preferred agentic tools via a web
      app."* Options A and C are the sanctioned path, not a consolation prize. What would be lost is
      the "it is a real add-on" flourish, not eligibility. Record the outcome here as **attempted and
      blocked, with the reason**, rather than quietly switching — a documented eligibility wall is a
      better answer in review than silence, and it is precisely the developer-experience feedback the
      hackathon explicitly asks entrants to submit.

      **B BLOCKED — ATTEMPTED AND STOPPED ON HARD EVIDENCE, 2026-09-19.** The spike was run and did
      not get past its first command. Two independent walls, either of which alone would be enough:

      1. **The Alexa AI CLI is not publicly installable.** `npm view @alexa-ai/cli` returns a plain
         404 on the public registry. Re-reading the setup page for the literal text explains why: the
         package lives in a **private AWS CodeArtifact registry** requiring
         `aws codeartifact login --tool npm --domain alexa-ai --repository npm-packages
         --domain-owner 372468808636 --region us-west-2 --namespace @alexa-ai --profile alexa-ai`,
         with an assumed role, and the page states the credentials are **provided by an "Alexa
         Solutions Architect" during onboarding**. That is a controlled-access program, not a
         self-serve install — no amount of engineering opens it, and it cannot be assumed to arrive
         inside a five-week window.
      2. **The marketplace/locale requirement** recorded above, with no African market on Alexa+'s
         live list or its stated 2027 plan.

      **⚠️ Supply-chain warning, recorded because the near-miss is easy.** There IS a public npm
      package called **`alexa-ai` (v2.5.0)** — it is an unrelated third-party WhatsApp chatbot, not
      Amazon's tool. Anyone hitting the 404 on `@alexa-ai/cli` and "helpfully" retrying without the
      scope would install a stranger's package globally. Do not. The Amazon CLI is `@alexa-ai/cli`
      from CodeArtifact and nothing else. (`ask-cli` v2.30.7 is real but is the legacy Alexa Skills
      Kit CLI — a different product, not the add-on toolkit.)

      **The block costs far less than it first appeared (2026-09-20).** An official Devpost
      update states the Alexa+ track as: *"build an Agent Skill **or a self hosted MCP server** on
      the open MCP standard"*, and points at `modelcontextprotocol.io`. A self-hosted MCP server
      is therefore a **first-class path, not a fallback** — which is exactly what
      `packages/mcp-server` is. The same update says outright: *"No MCP experience? Simulate the
      Alexa+ experience with any agentic tools you already know."*

      So the framing for the writeup is not "we wanted the add-on and could not get it". It is
      "we built the self-hosted MCP server the track asks for, and separately found that the
      add-on path is gated behind onboarding a hackathon entrant cannot self-serve" — which is
      a finding worth submitting as developer feedback rather than an apology. Keep the §7 record
      of the attempt; drop any language implying we fell short of the track's requirement.

      **Resolution: fall back to Option C, now.** This is not a retreat from B on preference; B was
      tried and is gated by access we do not have. C was the original recommendation and the MCP
      server is unchanged either way, so nothing built so far is wasted. Concretely: the Strands
      orchestrator plus a web chat UI standing in for Alexa+, which the track sanctions in as many
      words, and a Strands agent for the autonomous price-drop proposal that Alexa+ would not do.

      **Two things to carry forward rather than drop:**
      - **Ask about add-on access at office hours.** If a Solutions Architect can enrol this project,
        B becomes additive rather than a rewrite — same MCP server, plus OAuth and a deploy. Worth
        one question; not worth planning around.
      - **This is submittable feedback.** The hackathon explicitly asks where the developer
        experience fell short. "The Alexa+ track's headline path requires a CLI behind a private
        registry gated on Solutions Architect onboarding, and the docs do not say so until the
        environment-setup page" is precise, true, and useful to the team that owns it.

- **The agent has no way to discover a product, and can refuse without leaving a record.
  (opened 2026-09-19, found by running the model against the real stack — BLOCKS orchestrator
  step 3)**

  Two findings from the first live run, and the second is the serious one.

  **(a) CLOSED, verified live 2026-09-20.** With `search_catalog` in place the agent calls it
  unprompted and returns the real ids — "Product ID: `detergent-brand-a`" — instead of inventing
  `brand-a-detergent`. Confirmed by observing the tool call, not the reply text.

  **(b) STILL UNVERIFIED.** The run that would have answered it was lost to the 5-per-minute
  limit above. Since (a) was the suspected cause of (b), the honest position is that (b) may
  already be fixed and simply has not been measured. Do not build a structural fix for it until
  one clean run has been observed.

  **(a) There is no catalog tool.** Asked to restock Brand A, the model invented the product id
  `brand-a-detergent`; the real id is `detergent-brand-a`, and `propose_purchase` failed. Nothing
  in Vouch's nine tools lets an agent see what exists. This is a plain gap rather than a subtle
  one: UCP's own MCP binding specifies `search_catalog` as a merchant tool, and we implemented the
  merchant's REST side without ever exposing browsing to the agent.

  **(b) The model refused a purchase on its own judgement, calling no tools at all.** Asked to buy
  the $27.80 Brand C, it replied "I can only purchase Brand A or Brand B without requiring
  approval" and stopped. That answer is *correct* and it is the wrong behaviour, which is what
  makes it worth writing down. Refusing in the model leaves **no Vouch, no UCP session and nothing
  the household can question** — the refusal becomes an opinion in a chat log rather than a
  recorded act of the gate. The entire pitch is that the boundary is enforced and auditable, not
  that a well-prompted model behaves itself.

  **(a) is probably causing (b)**, and that ordering matters: with no product id the model
  *cannot* call `propose_purchase`, so falling back to conversation is the only move it has. Fix
  the catalog gap first and re-measure before building any machinery against (b). Do not add
  prompt threats about "always call the tool" until the tool is actually reachable.

  **Why this is a §3 decision rather than a quick fix:** it changes the MCP tool surface, which
  §10 of `CLAUDE.md` treats as load-bearing — "no tool completes a checkout directly" is asserted
  by a test, and any new tool has to keep that true. A read-only `search_catalog` does, but the
  decision belongs on the record either way. Options: expose a read-only catalog tool on Vouch's
  server; proxy the merchant's UCP MCP binding; or put the catalogue in the system prompt (cheap,
  and wrong the moment the catalogue changes).

  **Correction to an earlier reading, recorded because it nearly became a false finding.** The
  first rehearsal appeared to show the agent approving its own held purchase. It did not. A stale
  `mcp-server` from an earlier session still held port 4020, the newly started one died with
  `EADDRINUSE`, and the agent was talking to an older database. The lesson is about the finding
  process, not the agent: **check what the process is actually connected to before believing what
  it reports.**

- **Ring account linking needs a user-identity system this product does not have (opened
  2026-09-20 — decide before spending days on it).**

  Registering a webhook in the Ring Developer Portal requires three further URLs: an Account Link
  URL, a Token Exchange URL and an App Homepage URL. Verified against
  [Ring's API documentation](https://developer.amazon.com/docs/ring/api-documentation.html): this
  is **not** "be an OAuth server". Ring calls it one-way linking —

  1. Ring POSTs an authorization code to the Token Exchange URL; the partner redeems it against
     `https://oauth.ring.com/oauth/token` **within 60 seconds** and stores the result *unclaimed*.
  2. Ring redirects the user to the Account Link URL carrying `nonce` and `time`.
  3. The partner validates timestamp freshness (600s), then — the docs are explicit — **"must
     present a sign-in or create-account form. The sign-in establishes the partner-side user
     identity required to claim the unclaimed token."**
  4. The partner matches `HMAC-SHA256("<time>:<account_id>", hmac_key)` against the nonce, then
     calls App-Integrations POST and PATCH to complete.

  **Step 3 is the wall.** Vouch is a single local household with no accounts, no sign-in and no
  user table — §2's household multi-user story is already a recorded scope cut for exactly this
  reason. Account linking would mean building the identity model that cut avoided, on a secondary
  integration, against an Oct 23 deadline.

  **What real Ring would actually buy, stated honestly.** Not the honesty claim: §1 already
  establishes that Ring publishes no package-delivered event, so a real webhook yields
  *correlation against an expected window*, never proof — identical to what `MockRingProvider`
  reports. What it buys is Tech Implementation credit for a live API integration, and a demo beat
  where the doorbell is genuinely the owner's.

  **Recommendation: implement the receiving half for real, skip the linking half.** Build
  `RealRingProvider` as a genuine webhook receiver — HMAC-SHA256 verification over the raw body,
  real event parsing, real mapping into `PhysicalEvidence` — and exercise it with a *signed
  synthetic delivery through the live tunnel*. That makes the integration code real and tested
  rather than mocked, costs hours instead of days, and supports a claim that is precisely true:
  *"the webhook receiver, signature verification and event mapping are real; partner account
  linking is not completed, because it requires a user-identity system this product deliberately
  does not have."* Stating that plainly is stronger in review than a half-built login page.

  **DECIDED AND CLOSED 2026-09-20: receiver only, linking not attempted.** Agreed by the project
  owner. `RealRingProvider` is built, verified and opt-in behind `RING_MODE=real`;
  `MockRingProvider` stays the default so the demo's corroborated beat cannot silently break on
  an empty event store. The cloudflared tunnel and the capture listener have been shut down —
  quick-tunnel hostnames are ephemeral, so anything registered in the portal against
  `museums-sponsors-fwd-cricket.trycloudflare.com` is now dead and would need re-registering if
  this is ever picked up again.

  **What was learned along the way, worth keeping:**
  - The Ring portal saved the four URLs on **format validation only** — it never issued a
    reachability ping. So a saved configuration is not evidence that anything works, and no
    delivery will arrive until linking completes.
  - A quick tunnel can register at the Cloudflare edge and still never publish a DNS record: the
    first hostname was unreachable from three separate networks for six minutes. If a tunnel
    looks dead, cycle it before debugging anything else.
  - `webhook-capture.jsonl` contains four entries, all of them our own probes. **No Ring payload
    was ever captured**, which is precisely why `src/types.ts` is marked
    documented-not-captured rather than treated as verified.

  **If this is revisited:** the remaining work is the identity model, not the Ring code. The
  receiver, the signature verification and the correlation are done and tested.

- **CORRECTION (2026-09-20): the binding Gemini limit is 5 requests per MINUTE, not the daily
  one.** The quota id that actually fires is
  `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`, value 5. Since one conversational turn
  costs several requests — every tool result goes back to the model for another call — **a single
  agent turn can rate-limit itself halfway through**, and a test file running turns back to back
  exhausts it in seconds. The daily figure below is real but is rarely what stops you.
  - Mitigated in code, because a demo recording that dies on a 429 mid-sequence is far worse than
    one that pauses: `QuotaAwareRetryStrategy` in `packages/orchestrator/src/agent.ts` retries
    rate-limited calls, parsing the `"retryDelay": "42s"` Google supplies rather than guessing a
    backoff. Strands' own `DefaultModelRetryStrategy` does not cover this — it only treats
    `ModelThrottledError` as retryable, and Gemini's 429 arrives wrapped as a plain `ModelError`.
  - **`gemini-2.5-flash-lite` TRIED AND REJECTED (2026-09-20).** The obvious move, since quota is
    per-model and a lighter model would have bought a fresh budget. It does not work: the agent
    returns **empty replies and makes no tool calls**. 1 of 5 live tests passed, assertion inputs
    came back as `''`, and a demo rehearsal stalled on its first turn. On plain Flash the same
    code calls `search_catalog` unprompted and reports real ids. Note the trap — the standalone
    `npm run check:model` **passes** on Flash-Lite, because answering a plain prompt is not the
    thing it is bad at. Tool-calling is, and tool-calling is the orchestrator's whole job.
    So the quota ceiling stands until Bedrock, and it is a scheduling constraint on rehearsal
    rather than something a cheaper model solves.
  - **Process lesson, recorded because it cost a day's quota twice.** Run ONE live test, not the
    whole file: `npm run test:live -- --test-name-pattern="accepts being stopped"`. Running the
    full suite to answer a single question spends the budget that answering it needed.

- **Gemini free tier is 20 requests per day, per model (measured 2026-09-19).** Not per session —
  per day. One agent turn costs several requests, because each tool result goes back to the model
  for another call, so a five-turn rehearsal is roughly 10-15. In practice that is **about one
  full rehearsal per day** before `RESOURCE_EXHAUSTED`. This is a scheduling constraint on the
  demo, not a code problem, and it needs deciding before week 5: enable billing on the Google key,
  try `gemini-2.5-flash-lite` (separate quota), or move to Bedrock when the $150 credit lands.
  It is also why the live tests are opt-in (`npm run test:live`) and skipped by default.
