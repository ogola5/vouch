## Inspiration

Agentic shopping is already here. Amazon says Rufus was used by more than 300 million customers
and helped deliver nearly $12 billion in incremental annualized sales last year. Auto Buy, confirmed
once when you set it up, completes a purchase when the price reaches your target, with a 24-hour
window to cancel (as Modern Retail found when it tested it).

But a *household* has two moments nobody designs for:
- **"We're about to run out."** A price trigger or a calendar doesn't know.
- **"It bought something we didn't want."** Today the answer is a refund. Nothing changes what the
  agent does next time.

AP2 and Mastercard's Verifiable Intent standardized how an agent proves it was *authorized*. We
wanted the household's side: **hand over your everyday buying one item at a time, as the agent
earns it, and take it back with one sentence.** Their dispute gets your money back. Ours changes
what the agent is allowed to do next time.

## What it does

1. **You decide what it may do, item by item.**
   - *Remind* tells you. *Ask* suggests an order and waits. *Auto* buys within your limits and
     tells you after.
   - Trust is earned: after four "yes"es it offers to take an item on, for 90 days.
   - Trust is lost at once: a dispute moves the item back to Ask.
   - Each item shows its **trust history** as a line across Remind, Ask and Auto.
2. **It knows when you're running low.** A per-item forecast learns your home's pace from what you
   bought and from a one-tap "how much is left?". It orders when the risk of running out before
   delivery reaches 1 in 5.
3. **A gate runs before every order, on the store's own checkout** (UCP), between
   `ready_for_complete` and `completed`. It checks price, brand, quantity, whether this item may be
   bought unprompted, and whether the evidence is strong enough.
   - A held purchase leaves a real checkout parked one step short of an order.
   - **The agent has no tool that can approve.** Only you can, with your passkey.
4. **The device speaks first.** A held purchase announces itself: "A purchase needs your OK…", on
   screen, on the TV view, and out loud. **Voice can take power away ("keep it blocked") but never
   grant it.** Approving needs your passkey, and it says so.
5. **Every action leaves a record**, hash-chained, which you can question. "Why?" is answered from
   the record's facts, and a database edit is caught and named.
6. **One sentence changes the rules.** "I didn't want that" moves the item to Ask and tightens the
   bar. Then Vouch **re-runs the same gate on the same purchase against today's rules**: *"Then it
   bought this on its own. Today it would be held — it now asks you first."* That's a real re-check,
   not narration.

|  | Auto Buy | Scheduled Actions | AP2 / Verifiable Intent | **Vouch** |
|---|---|---|---|---|
| Buys without you at checkout | ✓ at a target price | ✗ ends at "review and check out" | payment-layer proof | ✓ per item, as far as you allow |
| Knows how much is left | ✗ | ✗ calendar | — | ✓ forecast |
| Holds an unusual purchase *before* the order | ✗ | — | records the authorization | ✓ gate on the checkout |
| **A dispute changes what it may do next** | not publicly described | — | not described | **✓, and re-checkable** |

We don't claim to have invented mandates, spending limits or audit trails: AP2, Mastercard and ACP
came first. We show where Vouch fits. **Every mandate exports as an AP2 Intent Mandate**, using
AP2's own six fields from its SDK. AP2's Intent Mandate has **no price field and nothing that
changes after a dispute**, so the export keeps those beside it. That part is Vouch.

## How we built it

- **A self-hosted MCP server** (TypeScript, Streamable HTTP), the track's named technology, used
  beyond plain tools:
  - **tool annotations**: only `propose_purchase` is marked destructive;
  - **typed results** (`outputSchema` / `structuredContent`);
  - **resources with subscriptions**: a subscribed client, as an Alexa+ device would be, is *told*
    when the gate holds a purchase.
  - The household's powers (approve, raise a limit, hand an item over) live on a separate,
    loopback-only surface no model can reach.
- **The agent:** a Strands agent on **Amazon Bedrock (Nova 2 Lite)** that uses only the MCP tools.
  Model-written "why" explanations are **checked against the record** before they're shown, with
  fixed wording as the fallback, and the page says which one you're reading.
- **The gate compares evidence, not the agent's opinion.** The agent's own confidence can only lower
  it:
  $$c = \min\left(c_{\text{agent}},\; f_{\text{need}} \cdot f_{\text{product}} \cdot f_{\text{price}}\right), \qquad \text{held if } c < \theta$$
- **Trust that adapts.** A dispute tightens the bar, and a run of good purchases loosens it, but
  never below the household's own number \\( \theta_0 \\):
  $$\theta \leftarrow \min(0.99,\ \theta + 0.03) \ \text{ on a dispute}, \qquad \theta \leftarrow \max(\theta_0,\ \theta - 0.02) \ \text{ every 2 undisputed}$$
- **The forecast:** a per-item lognormal pace, with a prior worth two refills. It orders when
  \\( P(\text{run out before delivery}) \ge \tfrac{1}{5} \\).
- **Passkeys** (WebAuthn, verified with `node:crypto`). The signature names the exact purchase and
  the record's chain head.
- **Ring:** an HMAC-verified webhook receiver. Ring publishes no "package delivered" event, so a
  motion event inside the delivery window is **corroborated — correlation, never proof**.
- **A TV-layout view** with D-pad navigation, and **voice** through the browser's own speech APIs.
- **Kept small on purpose:** `node:sqlite`, `node:http`, `node --test`, and one HTML file with no
  build step. **375 tests (366 pass; 9 need a live model)**, run by CI on every push.

## Evidence, not adjectives

Every figure is regenerated by `npm run eval` or a test, and the build fails if this page drifts
from them.

- **The adaptive loop** (synthetic, 12,000 decisions). Late in each history, unwanted purchases
  fell **32.0%** against a static mandate. **The cost: 1,120 wanted purchases held for approval.**
  Our first tuning cut harm by 76.8% but left the agent completing only 31.3% of what households
  wanted, which is switched off, not trustworthy. So we changed the default and published the
  whole curve.
- **Forecast vs a calendar** set to the household's own interval (synthetic, 1,200 item-years): it
  runs out **21.4%** less, keeps **54.2%** less stock, and buys **10.2%** fewer packs. **The cost:
  2.6 one-tap questions per household per week.**
- **Vs a price trigger modelled on Auto Buy:** households ran out **5.8×** as many days and
  reordered by hand **3.6×** as often. **Auto Buy paid 9.0% less**, because buying on deals is
  what it's for. With weekly deals it runs out slightly *less* than the forecast, but keeps about
  half a year of stock. A price trigger can't avoid both problems, because it never sees what's
  left.
- **Gate discipline on Bedrock** (Nova 2 Lite, live). An over-limit request went to the gate in
  **16/16** trials, up from 5/8 before one prompt fix. A standing instruction saved a faithful
  mandate and bought nothing in **5/5**, up from 0/5.
- **Security matrix: 20 attacks over MCP, 20 blocked.** They include self-approval, direct
  checkout, raising a limit, inflated confidence and a database edit.
- **An outside MCP client** connects knowing only the URL. It claims 0.99 confidence and is still
  held, is *told* the purchase is waiting, and its call to approve returns "Tool not found".
- **[OWNER: real people. Run the sessions with docs/study-kit.md, then state n, who they were,
  trust before → after, the cost ratio, and how many explained the Brand C stop in their own words.
  If none ran: "not yet tested with real people".]**

## Challenges we ran into

- **Getting the agent to defer instead of refuse.** Left alone, the model "helpfully" refused an
  over-limit purchase in chat, so the gate never ran and no record existed. A refusal that leaves no
  trace can't be questioned. We measured it, fixed it, and measured again.
- **Our own loop broke our own rule.** In simulation, good behaviour quietly loosened the agent
  past what the household set (0.85 → 0.669), and unwanted purchases rose 178%. The floor at the
  household's own number exists because of that run.
- **Being honest about Ring.** There's no delivery event, so we never say "delivered".
- **The Alexa+ add-on path is gated** behind onboarding we couldn't self-serve (see the feedback
  below). We built the self-hosted MCP server the track names, and a web stand-in for Alexa+.
- **[OWNER: Bedrock status. Since Oct 14 the AWS account has been refused Bedrock ("Error 002",
  every region). The model-backed figures above were measured Sep 27–28. Update this line once
  access is restored or the support case closes.]**

## Accomplishments that we're proud of

- **A gate that's real, not a caption:** a test asserts the order is never placed for an
  out-of-bounds proposal.
- **The adaptive loop, shown as a re-run of the same gate** rather than a number that moved.
- **Publishing the cost next to every win**, including where Auto Buy beats us.

## What we learned

The interesting question isn't whether an agent may buy. It's **how far, for whom, and how that
changes**. And the trade-offs are real: every "may I?" costs attention, which is why we publish the
curve instead of one flattering point.

## What's next

- **A real Alexa+ add-on:** the same MCP server, plus OAuth, once add-on access opens.
- **More than one person per household:** who may ask, and who may approve.
- **A real pilot**, measuring unwanted purchases, disputes, "may I?" questions per week, and
  whether people keep items on Auto.

**Who it's for, and how it would ship. These are our proposals, not commitments from anyone else:**
1. as an Alexa+ add-on;
2. in front of any UCP merchant, needing no merchant changes;
3. inside Amazon's own flow, where Auto Buy or Rufus could run the same check and let a dispute
   change what they may do next.

**What stays hard:**
- consumption isn't observed directly;
- Ring can only corroborate;
- every "may I?" costs attention;
- liability is a payment-network question.

## What's real, and what's simulated

Alexa+ is simulated by a web chat with voice, as the track permits. The merchant and payment are
simulated; no money moves. The console's doorbell is scripted (a real signed-webhook receiver
exists, off by default). The TV view is a TV-layout web page, not a native Fire TV app. Every
simulation is labelled in the app and in the README.

## Developer feedback

The Alexa+ add-on path (the MCP Toolkit) needs `@alexa-ai/cli`. It is only available from a private
AWS CodeArtifact registry, with credentials provided by an Alexa Solutions Architect during
onboarding, and the docs say so only on the environment-setup page. The marketplace list also
excludes our region. A public npm package named `alexa-ai` is unrelated, an easy supply-chain
mistake after the 404. Saying "requires onboarding" on the first page would save every entrant a
day.
