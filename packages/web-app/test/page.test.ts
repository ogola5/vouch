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

  it("works on a phone-width screen", () => {
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /prefers-color-scheme: dark/);
  });
});
