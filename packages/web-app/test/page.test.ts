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

  it("walks the demo script's five beats, and the tour never approves on your behalf", () => {
    const code = withoutComments(scriptBody());
    const tour = /const BEATS = \[([\s\S]*?)\n\];/.exec(code);
    assert.ok(tour, "the guided tour should be defined as BEATS");
    assert.equal((tour[1]!.match(/^\s{2}\{\s*$/gm) ?? []).length, 5, "one beat per step of brief §8's loop");
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

  it("works on a phone-width screen", () => {
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /prefers-color-scheme: dark/);
  });
});
