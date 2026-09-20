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

  it("works on a phone-width screen", () => {
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /prefers-color-scheme: dark/);
  });
});
