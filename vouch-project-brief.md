# Vouch

**The trust layer for what your AI agent actually did — not just what it says it will do.**

Amazon Developer Hackathon 2026 ("Build, Ship, Shape") — Primary track: **Alexa+**
Secondary integrations: **Ring** (physical evidence), **Fire TV** (household surface)
Mini-challenge: **AWS Builder** (Bedrock/AgentCore for reasoning + explanation)

---

## 1. The problem, in one paragraph

Alexa+ has already crossed the line from recommending purchases to making them. Auto-Buy
purchases items automatically once they hit a target price. Scheduled Actions restock household
staples on a recurring cadence. Alexa+ Agentic Ads let a shopper go from an ad straight to a
completed purchase inside a conversation. This is real and shipping. Every one of those
autonomous actions generates a technical transaction record — but nothing a person can actually
question, and no way for the agent's authority to change based on whether it got it right or
wrong last time.

## 2. Why this is defensible — the competitive landscape (check this before touching the pitch deck)

Three things already exist that could make this look derivative if you don't position it
correctly. Know them cold:

| Layer | Who | What it actually does | What it does NOT do |
|---|---|---|---|
| **KYA** (Know-Your-Agent) | Visa, Mastercard, Ant International — announced Sept 10, 2026 | Verifies *which agent* is acting and links it to a validated operator/cardholder | Says nothing about *why* an action happened or whether the real world confirms it |
| **ACP** (Agentic Commerce Protocol) | Stripe, OpenAI, Meta | Machine-readable audit trail + Shared Payment Tokens scoped by seller/time/$ | Merchant-facing compliance log — not conversational, not household-facing, not physically grounded |
| **UCP** (Universal Commerce Protocol) | Open standard — founded by Google, Shopify, Etsy, Target, Wayfair; Amazon, Meta, Microsoft, Salesforce and Stripe joined the UCP Tech Council in April 2026 | The actual checkout session spec you're building against — `/checkout-sessions` create/get/update/complete/cancel, `incomplete → ready_for_complete → completed`, reverse-DNS payment handlers, `.well-known/ucp` discovery, and REST, MCP and A2A transport bindings | A protocol, not a product — no explanation layer, no physical evidence, no adaptive trust |

**Vouch's actual differentiation, stated precisely:** it's the only layer that (1) explains an
action in language a household understands, (2) grounds that explanation in physical evidence
none of the above can access (Ring), and (3) **adjusts the agent's future authority based on what
actually happened** — a feedback loop none of the above have any reason to build, because none of
them live with the consequences of one specific household's history.

**Never say:** "we invented agent receipts / audit trails." That's shipped, in production, by
better-resourced teams, months before this hackathon. Say instead: "the protocol-level receipt
already exists — we built the human experience layer on top of it, using assets only Amazon has."

## 3. Why Amazon specifically

Real, current numbers (verified, not invented — don't add to this list without checking a
primary source first):
- 350M+ customers used Alexa for Shopping in the past year; active users nearly doubled;
  interactions up 5x+ YoY
- Customers using Alexa for Shopping spend 40%+ more per order
- Alexa+ users join Prime at ~25% higher rates

A verified payment token can prove an agent was *authorized* to spend $15. It cannot show you the
doorbell footage of the box actually arriving. Only Amazon owns a camera on the doorstep of
hundreds of millions of homes and a screen in the living room where a household already gathers.
That's the moat — not cleverness, an asset.

## 4. The core objects

### Mandate
A plain-language, structured authority boundary the agent must check *before* acting — not a
setting buried in an app, a real gate.

```json
{
  "mandate_id": "detergent-restock",
  "goal": "Keep laundry detergent stocked",
  "constraints": {
    "max_price": 15.00,
    "quantity": 2,
    "frequency": "P1M",
    "preferred_brand": "Brand A",
    "fallback_brand": "Brand B"
  },
  "requires_approval_if": ["price > max_price", "new_brand", "quantity > 2"],
  "authority_type": "explicit | delegated | inferred",
  "confidence_threshold": 0.85,
  "history": {
    "undisputed_actions": 0,
    "disputed_actions": 0,
    "last_adjusted": null
  }
}
```

### Vouch (the record object — this is your product's namesake)
Generated on every autonomous action. Ring "vouches" for the physical outcome; the object itself
is the household's record of the agent vouching for its own decision.

```json
{
  "vouch_id": "...",
  "intent": "Keep laundry detergent stocked",
  "authority": { "mandate_id": "detergent-restock", "within_bounds": true },
  "decision": { "product": "...", "price": 12.49, "reason": ["price_drop", "preferred_brand", "prior_purchase"] },
  "action": { "ucp_session_id": "...", "status": "Complete" },
  "evidence": {
    "digital": { "order_id": "...", "timestamp": "...", "payment_token_ref": "..." },
    "physical": { "ring_event_id": "...", "correlation_status": "corroborated | unconfirmed | not_applicable" }
  },
  "confidence": "high | medium | low",
  "user_controls": ["explain", "dispute", "pause_mandate", "adjust_limit"]
}
```

**Critical honesty rule for the Ring evidence field:** never write or say "Ring proves delivery."
Ring detects motion/a package-shaped object at a time — that's correlation with an expected
delivery window, not proof a specific order arrived. Use `corroborated` / `unconfirmed` states in
the demo, and show both at least once.

### The adaptive loop (the one genuinely new mechanism — lead with this)
When a user disputes a Vouch ("I didn't want that"), the relevant mandate's `confidence_threshold`
tightens automatically for that category — no manual settings edit. A streak of undisputed,
correctly-executed actions gradually widens it back. **This is the demo's best moment**: show the
agent make a borderline call, get disputed, and visibly get more conservative on that category the
next time — live, not narrated. Nothing in KYA, ACP, or UCP does this; they're static permission
systems. This is what makes Vouch a trust *relationship* instead of a *log*.

## 5. Technical architecture

```
HUMAN
  │
  ▼
MANDATE  (natural language → structured authority object)
  │
  ▼
ALEXA+ (simulated, per track guidance — "simulate an Alexa+ experience via a web app")
  │
  ├── MCP Server (yours) ── gates every action against the live mandate BEFORE it proceeds
  │
  └── Mock merchant backend implementing real UCP session lifecycle
         (Create → Update → Complete/Cancel)
  │
  ▼
VOUCH generated at every step
  │
  ┌────────────┴────────────┐
  ▼                          ▼
DIGITAL EVIDENCE        PHYSICAL EVIDENCE
(UCP order/session)     (real Ring webhook, correlated not claimed as proof)
  │                          │
  └────────────┬─────────────┘
               ▼
     FIRE TV — household-visible surface
     "why did you do this" / dispute → adjust mandate / pending approvals
```

**Important correction to carry forward:** there is no confirmed public "synthetic MCP commerce
service" provided by the hackathon. Build a minimal mock merchant backend yourself, implementing
the real UCP session shape. This is more credible anyway — it proves you understood the published
spec well enough to implement both sides of it. State plainly in the submission what's real
(Ring webhook, MCP server, mandate logic) vs. simulated (checkout execution, payment).

## 6. Resources, mapped to build order

**Day 1 — install, no dependencies:**
- [Amazon Devices Builder Tools](https://developer.amazon.com/) — MCP server + Agent Skills for
  your coding assistant. Install before writing anything else.

**Alexa+ track (primary):**
- "Build with Agent Skills" + "Streamable HTTP transport" docs — your actual foundation. The
  track explicitly says: *"You can simulate an Alexa+ experience using your preferred agentic
  tools via a web app."* That's your green light — no real Alexa+ production access needed.
- The UCP checkout specification at [ucp.dev](https://ucp.dev/specification/checkout-rest/)
  (REST binding, snapshot `2026-04-08`) — implement this shape faithfully on your mock merchant.
  This is the open standard, not an Amazon document; see the correction in section 2's table.
  `packages/shared/src/ucp.ts` is now written against it directly.

**Ring:**
- Ring Developer portal — free account first, gates everything else here.
- `ring-api-helloworld` — fork as your webhook skeleton.
- Ring API reference — webhooks + rate limits section is where your correlation logic lives.
- UX design guide — skim before building the Fire TV evidence display.

**Fire TV (supporting, not primary — don't over-invest here):**
- `hello-world-fire-tv-react-native` — the 5-minute starter is the right scope. This is a
  household activity dashboard, not a media app. Don't reach for `vega-video-sample`.

**AWS Builder mini-challenge:**
- Bedrock or AgentCore for: (a) generating the plain-language Vouch explanation, (b) deciding how
  much a dispute should tighten a mandate's confidence threshold.

**Open Source mini-challenge (optional, separate task):**
- Must be a real contribution to an *existing* public repo — not publishing your own. Don't let
  this eat time that belongs to the core build.

**Office hours:** book a slot for week 2–3, specifically for Ring webhook/auth edge cases.

## 7. Five-week build sequence

1. **Week 1 — Mandate model.** Natural-language input → structured mandate object. This is the
   foundation everything checks against.
2. **Week 2 — MCP server + mock UCP merchant.** Real Create/Update/Complete/Cancel lifecycle.
   Every step generates a Vouch. **Priority: the mandate check must be a real gate before Complete
   fires — not a caption added after the fact.** This is the single highest-leverage engineering
   decision in the whole project.
3. **Week 3 — Ring correlation + the adaptive/dispute loop.** Real webhook, honest
   corroborated/unconfirmed states. Wire up dispute → mandate-tightening.
4. **Week 4 — Conversational query layer.** "What did you buy me this month," "why didn't you buy
   the $27 one," "show me what was inferred vs. explicit."
5. **Week 5 — Fire TV dashboard, AWS Builder integration, demo video, polish, submission writeup.**

## 8. The demo script (the 3-minute clip to build toward)

1. Set a mandate by voice: "keep detergent stocked, under $15, monthly."
2. Price drops → agent buys within bounds → Vouch generated, Ring corroborates delivery.
3. Agent encounters a $27.80 item → **stops**, asks for approval (real gate, not staged).
4. User asks "why didn't you buy it?" → agent explains the actual boundary that stopped it.
5. User disputes an earlier borderline Vouch → **mandate visibly tightens** → next similar
   decision, agent is more conservative, live on screen.
6. Fire TV shows the household view: completed / pending / disputed, with the before/after
   mandate state visible.

That sequence — mandate → real action → real stop → real explanation → real adjustment — is the
whole thesis in under 3 minutes, without narration.

## 9. Guardrails — things to never claim, established the hard way over many rounds of critique

- Never claim Ring "proves" delivery — correlation only.
- Never claim to have invented agent audit trails / receipts — ACP shipped this first.
- Never cite a specific date/quote for "when Amazon adopted MCP" — no confirmed primary source
  exists for this; don't need it, the dated UCP docs are better evidence anyway.
- Never use a fabricated precision score (e.g., "9.5/10 strategic fit") anywhere in the
  submission — no rubric backs numbers like that.
- Never imply the household surveillance/monitoring framing — this is about accountability for
  the *agent*, not surveillance of a person.
- Never describe UCP as "Amazon's spec" or "Amazon's own open spec" — it is an open standard
  founded by Google, Shopify, Etsy, Target and Wayfair, which Amazon joined the Tech Council of
  in April 2026. Judges here are Amazon product and engineering leads and will know this. The
  accurate framing is stronger anyway: this is a household trust layer built on the open standard
  Amazon has just committed to, proving a gap before Amazon's product teams prioritized closing
  it. The hackathon explicitly exists to feed submissions to those teams.
- Never imply Amazon "can't" build this themselves — see the framing above.
- Always state plainly, in the submission, exactly which parts are real (MCP server logic, Ring
  webhook, mandate gating) and which are simulated (checkout execution, payment processing).

## 10. Judging criteria alignment (for your own reference, not to repeat verbatim to judges)

- **Tech Implementation:** real MCP server, real UCP-shaped session lifecycle, real Ring webhook,
  real gating logic — not a mockup.
- **Design:** kitchen → agent action → Ring evidence → Fire TV household surface. Coherent,
  physical, easy to follow without narration.
- **Potential Impact:** tied directly to Amazon's stated growth engine (Alexa for Shopping) and a
  trust gap the industry (KYA, ACP) is actively racing to solve at a different layer.
- **Quality of Idea:** the adaptive-mandate/dispute loop is the one mechanism competitors in this
  space (KYA, ACP, UCP) have no structural reason to build.
