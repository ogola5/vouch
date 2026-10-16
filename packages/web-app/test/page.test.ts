import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

/**
 * Static checks on the console page.
 *
 * These exist because of how the dispute button failed: it was wired
 * correctly, the server returned 200, and nothing happened — the browser
 * silently refused `window.prompt()` and the handler took the cancelled path.
 * Nothing in the suite could have caught that, because every test talked to
 * the API and none of them looked at the page.
 *
 * A browser-driving test would catch more, and would also add a dependency
 * and a headless browser to a repo that has neither. These are the checks
 * worth having without that: the script parses, every element it reaches for
 * exists, and it uses no dialog a host may refuse to show.
 */

const PAGE = new URL("../public/index.html", import.meta.url);
const html = readFileSync(PAGE, "utf8");

/** The inline module, minus comments, so prose about `prompt()` is not a hit. */
function scriptBody(): string {
  const match = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "the page should carry exactly one inline module");
  return match[1]!;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the console page holds together", () => {
  it("parses as JavaScript", () => {
    // A syntax error anywhere kills every handler on the page at once, and
    // the page still renders — so it looks like "the buttons do nothing".
    assert.doesNotThrow(() => new Script(scriptBody(), { filename: "index.html" }));
  });

  it("only reaches for elements that exist", () => {
    const ids = new Set(Array.from(html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g), (m) => m[1]!));
    const referenced = new Set(
      Array.from(scriptBody().matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g), (m) => m[1]!)
    );

    const missing = [...referenced].filter((id) => !ids.has(id)).sort();
    // This is the bug that was hit for real: an element was removed from the
    // markup while `$("noMandate").hidden = …` stayed behind, and everything
    // rendered after that line stopped working.
    assert.deepEqual(missing, [], `script reaches for ids the page does not define: ${missing.join(", ")}`);
  });

  it("uses no blocking dialog", () => {
    const code = withoutComments(scriptBody());
    for (const dialog of ["prompt(", "alert(", "confirm("]) {
      assert.ok(
        !code.includes(dialog),
        `${dialog} is blocked outright in VS Code's Simple Browser and in sandboxed ` +
          `iframes — it returns null and the handler silently does nothing`
      );
    }
  });

  it("keeps the honest Ring wording the guardrails require", () => {
    // BUILD_PLAN §4: correlation, never proof, and never a boolean "delivered".
    assert.match(html, /correlation, never proof/i);
    assert.ok(!/\bproves? delivery\b/i.test(html), "the page must never claim delivery was proven");

    const code = withoutComments(scriptBody());
    for (const status of ["corroborated", "unconfirmed", "not applicable"]) {
      assert.ok(code.toLowerCase().includes(status), `the page should render "${status}"`);
    }
  });

  it("renders every tool the agent can call", () => {
    // If a tool is added to the MCP surface and not given a phrase here, the
    // transcript shows a raw function name mid-demo.
    const code = scriptBody();
    for (const tool of [
      "search_catalog",
      "create_mandate",
      "propose_purchase",
      "record_dispute",
      "list_vouches",
      "explain_vouch",
      "get_mandate",
      "list_mandates",
      "pause_mandate",
    ]) {
      assert.ok(code.includes(tool), `no household-language label for ${tool}`);
    }
  });

  it("walks demo script v2's seven beats, household first, and the tour never approves on your behalf", () => {
    const code = withoutComments(scriptBody());
    const tour = /const BEATS = \[([\s\S]*?)\n\];/.exec(code);
    assert.ok(tour, "the guided tour should be defined as BEATS");
    assert.equal((tour[1]!.match(/^\s{2}\{\s*$/gm) ?? []).length, 7, "one beat per step of demo script v2 (BUILD_PLAN.md §3b)");
    const titles = [...tour[1]!.matchAll(/title: "([^"]+)"/g)].map((m) => m[1]);
    assert.equal(titles[0], "Meet your household", "the household comes first");
    assert.ok(titles.includes("Only you can say yes") && titles.includes("Check the record"));
    // A tour button that approved a held purchase would make the gate look
    // decorative on the one screen built to show it is not. Approval stays a
    // separate, deliberate click by the household.
    assert.ok(!/approve\(/.test(tour[1]!), "no tour step may approve a held purchase");
    // Its fallback acts as the agent THROUGH the gate, never around it.
    assert.match(code, /callTool\("propose_purchase"/);
    assert.ok(!code.includes("complete_checkout"), "the page must never reach for a direct checkout");
  });

  it("never renders the model's words or a mandate's text as HTML", () => {
    // The agent's reply and a household-typed goal both end up in innerHTML.
    // Unescaped, a reply containing markup would be injected into the page.
    const code = withoutComments(scriptBody());
    // Raw interpolation into a template is the risk; `${esc(body.text)}` is fine.
    for (const source of ["body.text", "body.error", "m.goal", "d.reason", "e.message", "text}"]) {
      assert.ok(!code.includes("${" + source), `\${${source} is interpolated into markup without esc()`);
    }
    assert.match(code, /\$\{esc\(body\.text\)\}/, "the agent's reply should be rendered through esc()");
  });

  it("says plainly what is simulated, including the doorbell in this console", () => {
    assert.match(html, /What's real here, and what's simulated/);
    assert.match(html, /doorbell in this console/i);
    assert.match(html, /no money moves/i);
  });

  it("does not decide 'no model' from one health check made while the stack was starting", () => {
    // Hit for real: `npm run dev:all` starts all three services at once, the
    // page's only health check ran before the MCP server was up, and the chat
    // refused to send to a working Bedrock agent for the rest of the session.
    const code = withoutComments(scriptBody());
    const say = /async function say\(message\) \{([\s\S]*?)\n\}/.exec(code);
    assert.ok(say, "say() should exist");
    assert.ok(!/chatReady/.test(say[1]!), "say() must let the server decide whether a model is available");
    assert.match(code, /setTimeout\(chatBanner/, "a failed health check should be retried, not believed");
  });

  it("answers a notice through the household's own routes, never through approval", () => {
    // An in-limits "Order it" is the household asking — it goes through the
    // gate as a request. Approving something the gate HELD is a different,
    // deliberate act, and the household panel must not blur the two.
    const code = withoutComments(scriptBody());
    const panel = /function renderHousehold\(\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    const needs = /function needsFor\(item\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    assert.ok(panel && needs, "the household panel should be rendered by renderHousehold/needsFor");
    assert.match(panel, /\/respond`/);
    assert.ok(!/approve/.test(panel), "the household panel must not call approve");
    assert.match(needs, /data-r="order"/);
    assert.match(needs, /Only you can approve it/, "a held purchase points to the record, where approval lives");
  });

  it("says uncertainty gently instead of printing a raw range", () => {
    const code = withoutComments(scriptBody());
    assert.match(code, /could be sooner/);
    assert.ok(!/\$\{f\.daysLeft\.low\}/.test(code), "a raw '0 to 15 days' reads as a shrug");
  });

  it("escapes every item name and brand it puts into the page", () => {
    const code = withoutComments(scriptBody());
    for (const raw of ["${item.name}", "${n.brand}", "${name}"]) {
      // `name` is built with esc() once, then reused; the other two must be wrapped at use.
      if (raw === "${name}") assert.match(code, /const name = esc\(item\.name/);
      else assert.ok(!code.includes(raw), `${raw} is interpolated without esc()`);
    }
  });

  it("dates a suggestion from today, not from when it was made", () => {
    // Rendering the real pantry showed "it would arrive Wed, Sep 30" on Oct 4.
    const needs = /function needsFor\(item\) \{([\s\S]*?)\n\}/.exec(withoutComments(scriptBody()))?.[1] ?? "";
    assert.match(needs, /Math\.max\(n\.delivery_day, hh\.today \+ lead\)/);
  });

  it("lets the server decide what needs a passkey, and signs only what it names", () => {
    // The page must not compose protected actions itself: it signs the
    // challenge the server returned with its 401, then retries.
    const code = withoutComments(scriptBody());
    const call = /async function protectedCall\(path, method, body\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    assert.match(call, /res\.status === 401 && json\.needs_passkey/);
    assert.match(call, /signFor\(json\)/);
    // Approving a held purchase and editing a mandate both go through it.
    assert.match(code, /protectedCall\(`vouches\/\$\{encodeURIComponent\(vouchId\)\}\/approve`/);
    assert.match(code, /protectedCall\(`mandates\//);
  });

  it("explains, rather than fails, when opened on an IP address", () => {
    // Browsers refuse passkeys on 127.0.0.1; the page points to localhost.
    assert.match(scriptBody(), /Browsers only allow passkeys on a named site/);
  });

  it("reports a tampered record in words, and labels the tamper button as a simulation", () => {
    const code = withoutComments(scriptBody());
    assert.match(code, /This record has been altered outside the app/);
    assert.match(code, /Record verified/);
    assert.match(html, /Simulate someone editing an old record/);
  });

  it("shows how every record was decided, and says plainly when a checkout stopped at the gate", () => {
    const code = withoutComments(scriptBody());
    assert.match(code, /\$\{howItDecided\(v\)\}/);
    assert.match(code, /reached “ready to complete” and stopped there/);
    // Every check the gate can emit has a household-language name.
    for (const rule of ["mandate_active", "below_confidence_threshold", "price > max_price", "new_brand", "autonomy_not_granted", "autonomy_expired"]) {
      assert.ok(code.includes(`"${rule}"`) || code.includes(`${rule}:`), `no name for check ${rule}`);
    }
  });

  it("offers 'Keep blocked' beside every Approve, and never shows a failed price as $0.00", () => {
    const code = withoutComments(scriptBody());
    const approves = code.split('data-approve="${v.vouch_id}"').length - 1;
    const declines = code.split('data-decline="${v.vouch_id}"').length - 1;
    assert.equal(declines, approves, "a held purchase must always offer both answers");
    assert.match(code, /price unknown/);
    assert.match(code, /Failed — nothing bought/);
  });

  it("labels every failure switch as a simulation", () => {
    assert.match(html, /Simulate failures/);
    const code = withoutComments(scriptBody());
    assert.match(code, /DOWN \(simulated\)/);
    assert.match(code, /The store is down \(simulated\)/);
    // The doorbell switch must keep the honest wording.
    assert.match(code, /correlation, never proof/);
  });

  it("can say 'nobody asked' on the record", () => {
    assert.match(scriptBody(), /Nobody asked — your household agent did this on its own/);
  });

  it("runs a study session with consent first, a code not a name, and each question at its moment", () => {
    const code = withoutComments(scriptBody());
    const render = /function renderStudy\(\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    // Consent is its own stage, and the wording says where answers go.
    assert.match(render, /study\.stage === "consent"/);
    assert.match(render, /on this computer only/);
    assert.match(render, /code instead of your name/);
    assert.match(render, /Nothing is sent anywhere/);
    assert.match(render, /stop at any time/);
    // The participant gets a generated code; nothing on the page asks for a name.
    assert.match(code, /participant: `P-\$\{/);
    assert.ok(!/your name\s*<\/label>|placeholder="Name/i.test(render), "the study must never ask for a name");
    // Questions arrive with the tour: after step 4 (the held purchase) and step 6 (the dispute).
    assert.match(render, /BEATS\[3\]\.done\(\)/);
    assert.match(render, /BEATS\[5\]\.done\(\)/);
    assert.match(code, /household\("study"/);
    // Results can be exported for the write-up.
    assert.match(html, /id="studyExport"/);
    assert.match(code, /text\/csv/);
  });

  it("draws Auto Buy vs Vouch from the replay, labelled as a simulated household (W4-2)", () => {
    const code = withoutComments(scriptBody());
    assert.match(code, /api\(`\/api\/replay\?household=\$\{replayHouseholdNo\}&deals=/);
    assert.match(html, /a simulated household, not yours/);
    assert.match(html, /assumptions, not Amazon data/);
    // Auto Buy's own win is shown, not hidden.
    assert.match(code, /Price paid, compared with usual/);
    assert.match(code, /Auto Buy should pay less/);
    // Every number in the table is computed from the replay's metrics.
    const render = /function renderReplay\(r\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    assert.ok(!/\b(19,?464|3,?375|10,?028|2,?819)\b/.test(render), "no published figure typed into the panel");
    assert.match(render, /i\[policy\]\.metrics/);
    assert.match(render, /esc\(i\.name\)/);
  });

  it("is organised as views, with the household first and the chat beside every view", () => {
    for (const view of ["home", "record", "rules", "compare", "tv", "talk", "demo"]) {
      assert.match(html, new RegExp(`class="[^"]*view[^"]*" data-view="${view}"`), `no ${view} view`);
    }
    assert.match(html, /<body data-view="home">/);
    // Home comes first in the markup, and starts with what needs the household.
    assert.ok(html.indexOf('data-view="home"') < html.indexOf('data-view="record"'));
    assert.ok(html.indexOf('id="pending"') < html.indexOf('id="hhItems"'), "what needs you comes before the item list");
  });

  it("keeps the demo machinery out of the product unless presenter mode is on", () => {
    // The tour, the Demo view and the clock controls are presenter-only.
    assert.match(html, /<section class="dock presenter-only"/);
    assert.match(html, /data-tab="demo" class="presenter-only"/);
    for (const id of ["hhFwd1", "hhFwd7"]) assert.match(html, new RegExp(`class="small demo-only" id="${id}"`));
    assert.match(html, /body:not\(\.presenter\) \.presenter-only, body:not\(\.presenter\) \.demo-only \{ display: none !important; \}/);
    const code = withoutComments(scriptBody());
    // On for a recording with ?presenter=1, and from Home's "Take the tour".
    assert.match(code, /get\("presenter"\) === "1"/);
    assert.match(code, /\$\("tourStart"\)\.addEventListener\("click", \(\) => \{\s*setPresenter\(true\)/);
  });

  it("never scrolls to something hidden in another view", () => {
    // Every jump to an element switches to its view first.
    const code = withoutComments(scriptBody());
    const raw = code.match(/scrollIntoView\(\{ block: "center"/g) ?? [];
    assert.equal(raw.length, 1, "only reveal() itself may scroll to centre");
    assert.match(code, /function reveal\(el\) \{[\s\S]*?el\.closest\("\.view"\)/);
  });

  it("shows a held purchase once on Home, not twice", () => {
    assert.match(withoutComments(scriptBody()), /\.filter\(\(n\) => n && n\.cls !== "held"\)/);
  });

  it("draws the TV view only once the household has loaded, and drives it with a D-pad", () => {
    const code = withoutComments(scriptBody());
    // Opening #tv directly used to call renderTv before `hh` existed, which
    // threw and stopped the page at "connecting…".
    assert.match(code, /if \(view === "tv" && tvReady\) renderTv\(\);/);
    assert.match(code, /tvReady = true;\s*if \(document\.body\.dataset\.view === "tv"\) renderTv\(\);/);
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"]) assert.ok(code.includes(key), key);
    // It says what it is.
    assert.match(code, /TV layout · ← ↑ ↓ → to move/);
    assert.match(html, /The TV view is a TV-layout web page, not a native Fire TV app/);
    const tv = /function renderTv\(\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    assert.ok(!/\$\{(item\.name|v\.decision\.product)\}/.test(tv), "TV text is escaped");
  });

  it("shows what a dispute changed by re-checking, never by narrating (S1)", () => {
    const code = withoutComments(scriptBody());
    assert.match(code, /household\(`vouches\/\$\{encodeURIComponent\(v\.vouch_id\)\}\/recheck`\)/);
    assert.match(html, /id="changedBlock"[^>]*hidden/);
    // Says how it knows, and that nothing was bought doing it.
    assert.match(code, /Re-checked just now by the same gate/);
    assert.match(code, /No checkout, nothing bought/);
    // A record the server can't re-check is shown as such, not dressed up.
    assert.match(code, /if \(!r\.recheckable\) return/);
    const fn = /function recheckHtml\(r, v\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    assert.ok(!/\$\{c\.detail\}|\$\{r\.reason\}/.test(fn), "server text is escaped");
  });

  it("lets you speak to the stand-in and hear it answer, saying where the audio goes (S2)", () => {
    const code = withoutComments(scriptBody());
    // Feature-detected: no mic button where the browser can't listen.
    assert.match(code, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);
    assert.match(html, /id="chatMic" hidden/);
    assert.match(html, /in Chrome and Edge, recognition runs in the browser maker's cloud/);
    // Speaking to it switches spoken replies on; the "why?" answer is spoken too.
    // (D1 checks for "keep it blocked" in between; replies are on either way.)
    assert.match(code, /setSpeak\(true\);[\s\S]{0,400}?say\(final\.trim\(\)\)/);
    assert.match(code, /speak\(lines\.join\(" "\)\)/);
  });

  it("trims a reply for listening: no record ids, no markdown, a couple of sentences", () => {
    const code = withoutComments(scriptBody());
    const src = /function forVoice\(text\) \{[\s\S]*?\n\}/.exec(code)?.[0];
    assert.ok(src, "forVoice exists");
    const forVoice = new Function(`${src}; return forVoice;`)() as (t: string) => string;
    assert.equal(
      forVoice("I stopped before buying **Brand C** (vouch_8da04506-2a67) at $27.80. It is over your $15.00 limit."),
      "I stopped before buying Brand C at $27.80. It is over your $15.00 limit."
    );
    // Long replies stop at a sentence end — never inside a price.
    const long = forVoice(
      "I stopped before buying Brand C at $27.80. It is over your $15.00 limit and a brand you have not approved. " +
        "The checkout is parked one step short of an order, so nothing was bought and nothing was charged. " +
        "You can approve it with your passkey or keep it blocked from the record, whichever you prefer."
    );
    assert.ok(long.length <= 240, long);
    assert.match(long, /\$27\.80\..*\.$/);
    assert.ok(!/\$27\.$/.test(long) && !long.includes("You can approve"), long);
    assert.equal(forVoice("Checked · bought · done."), "Checked, bought, done.");
  });

  it("draws each item's trust history from the agent's record, with disputes marked (L1)", () => {
    const code = withoutComments(scriptBody());
    const fn = /function trustTrack\(item\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    assert.match(fn, /item\.settings\.modeHistory/);
    assert.match(fn, /v\.dispute \?/);
    assert.match(fn, /aria-label="How far \$\{esc\(item\.name\)\} is handed over/);
    assert.match(code, /\$\{trustTrack\(item\)\}/);
  });

  it("keeps item cards lean: the controls live behind Adjust, and stay open across refreshes (L2)", () => {
    const code = withoutComments(scriptBody());
    const card = /function itemCard\(item\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    const more = card.slice(card.indexOf('<details class="item-more"'));
    for (const control of ["data-hh-mode", "data-hh-until", "data-hh-weekends", "data-hh-level", "data-hh-plenty"]) {
      assert.ok(more.includes(control), `${control} should be inside Adjust`);
    }
    assert.match(code, /openAdjust\.add\(d\.dataset\.hhAdjust\)/);
  });

  it("says how careful it is in words, keeping the number (L2)", () => {
    const code = withoutComments(scriptBody());
    assert.match(code, /More careful than you set/);
    assert.match(code, /As careful as you set/);
    assert.match(code, /\$\{esc\(carefulText\(m, diff\)\)\}/);
  });

  it("sums up what it has done in one sentence, counted from the record (L2)", () => {
    const code = withoutComments(scriptBody());
    const src = /function soFarText\(\) \{[\s\S]*?\n\}/.exec(code)?.[0];
    assert.ok(src);
    const run = (vouches: unknown[]) => new Function("state", `${src}; return soFarText();`)({ vouches }) as string;
    const v = (status: string, started_by: string, price: number, extra: Record<string, unknown> = {}) =>
      ({ action: { status }, trace: { started_by }, decision: { price, reason: [] }, dispute: null, ...extra });
    assert.equal(run([]), "");
    assert.equal(
      run([v("Complete", "household_agent", 12.49), v("Complete", "household_agent", 13.99, { dispute: { disputed_at: "x" } }),
           v("Complete", "household", 9.99), v("PendingApproval", "mcp_tool", 27.8)]),
      "So far it has bought 2 things on its own ($26.48), ordered 1 thing when you said yes and is holding 1 for you. " +
        "You've said “I didn't want that” once — and it got more careful."
    );
  });

  it("starts with one clear step, and announces a change of mode (L3)", () => {
    const code = withoutComments(scriptBody());
    assert.match(html, /id="firstRun"/);
    assert.match(code, /document\.body\.classList\.toggle\("first-run-on", !hh\.set_up\)/);
    assert.match(code, /justChanged\.add\(i\.item_id\)/);
    assert.match(code, /toast\(`\$\{i\.name\}: \$\{MODE_NAME\[before\]\} → /);
  });

  it("updates itself when the record changes on the server (T4)", () => {
    const code = withoutComments(scriptBody());
    assert.match(code, /new EventSource\("\/api\/events"\)/);
    assert.match(code, /addEventListener\("record"/);
  });

  it("announces a held purchase on every view, and says approving needs the passkey (D1)", () => {
    const code = withoutComments(scriptBody());
    assert.match(html, /<div class="needs-ok" id="needsOk" role="alert" hidden>/);
    const fn = /function announceHeld\(\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    assert.match(fn, /if \(fresh\.length\) speak\(heldSentence\(fresh\[0\]\)\)/, "only a NEW hold is spoken");
    assert.match(fn, /Approving needs your passkey/);
    assert.match(fn, /data-no-block/);
    assert.ok(!/approve\(/.test(fn), "the banner must never approve");
    assert.match(code, /renderTour\(\);\s*announceHeld\(\);/);
  });

  it("keeps the mic working without a model, for the household's own commands", () => {
    const code = withoutComments(scriptBody());
    assert.ok(!/\$\("chatMic"\)\.disabled = !chatReady/.test(code), "the mic must not depend on the model");
    assert.match(code, /handleVoiceIntent\(final\.trim\(\)\)\)[\s\S]{0,120}if \(!chatReady\)/);
  });

  it("lets voice narrow but never widen (D1)", () => {
    const code = withoutComments(scriptBody());
    const src = /function voiceIntent\(text\) \{[\s\S]*?\n\}/.exec(code)?.[0];
    assert.ok(src);
    const voiceIntent = new Function(`${src}; return voiceIntent;`)() as (t: string) => string | null;
    for (const said of ["Keep it blocked", "block that", "don't buy it", "No, don't", "cancel that"]) {
      assert.equal(voiceIntent(said), "block", said);
    }
    for (const said of ["approve it", "Yes, buy it", "go ahead and buy it"]) assert.equal(voiceIntent(said), "approve", said);
    for (const said of ["what did you buy?", "why didn't you buy that?", "keep detergent stocked"]) assert.equal(voiceIntent(said), null, said);

    // "approve" by voice is answered, never obeyed.
    const handle = /async function handleVoiceIntent\(text\) \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? "";
    assert.match(handle, /needs your passkey — not your voice/);
    assert.ok(!/approve\(|protectedCall/.test(handle), "voice must not reach the approve path");
    assert.match(handle, /await decline\(held\.vouch_id\)/);
  });

  it("shows each mandate as an AP2 Intent Mandate, escaped, with what AP2 can't express (Q1)", () => {
    const code = withoutComments(scriptBody());
    assert.match(code, /<details class="ap2" data-ap2="\$\{esc\(m\.mandate_id\)\}">/);
    assert.match(code, /api\(`\/api\/ap2\/\$\{encodeURIComponent\(d\.dataset\.ap2\)\}`\)/);
    assert.match(code, /\$\{esc\(JSON\.stringify\(x\.intent_mandate, null, 2\)\)\}/);
    assert.match(code, /Not representable in AP2/);
  });

  it("works on a phone-width screen", () => {
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /prefers-color-scheme: dark/);
  });
});
