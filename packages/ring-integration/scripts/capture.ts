import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A throwaway receiver whose only job is to find out what Ring actually sends.
 *
 * WHY THIS EXISTS RATHER THAN CODING STRAIGHT FROM THE DOCS. The last time
 * this project wrote types from a prose description — the UCP checkout shape —
 * the guess was wrong in almost every particular: the id field, the status
 * enum, the money units, the whole envelope. That mistake is recorded in
 * BUILD_PLAN.md §1 as the strongest argument for checking early. The Ring
 * docs give an `X-Signature` header and a `meta`/`data` envelope, but a
 * summarised doc page is not a captured request, so this logs EVERY header
 * and the raw bytes and lets the wire settle it.
 *
 * It is deliberately not in src/. This is an operational tool for one
 * afternoon, not part of the package's API, and nothing should be able to
 * import it by accident.
 *
 * Zero dependencies, like the rest of the repo — node:http and node:crypto
 * cover all of it.
 */

const PORT = Number(process.env.RING_CAPTURE_PORT ?? 4100);

/**
 * Accepts either name. The Ring Developer Portal labels its three values
 * `CLIENT_ID`, `CLIENT_SECRET` and `HMAC_SIGNATURE_KEY`, so those are what a
 * developer has in front of them to paste. The `RING_`-prefixed forms are
 * preferred in this repo because the root `.env` is shared by every service —
 * a bare `CLIENT_ID` will collide the first time an AWS or Amazon developer
 * credential lands beside it, and that collision is silent.
 *
 * Reading both costs one `??` and removes a transcription step, which is
 * worth more than tidiness while wiring up a live integration.
 */
const HMAC_KEY = process.env.RING_HMAC_KEY ?? process.env.HMAC_SIGNATURE_KEY ?? "";

/** Package root, resolved from this file so the cwd does not matter. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURE_FILE = process.env.RING_CAPTURE_FILE ?? resolve(PACKAGE_ROOT, "webhook-capture.jsonl");

/** Headers whose value should never be written to the capture file verbatim. */
const SENSITIVE = new Set(["authorization", "cookie", "proxy-authorization"]);

interface CapturedRequest {
  captured_at: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  raw_body: string;
  parsed_body: unknown;
  json_parse_error?: string;
  signature_check: "no_key_set" | "no_signature_header" | "valid" | "INVALID";
}

/**
 * Verifies `sha256=<hex>` over the RAW body bytes.
 *
 * The raw string matters: re-serialising the parsed JSON would reorder keys
 * or change spacing and the digest would never match, which is the classic
 * way webhook verification is broken while looking correct.
 */
function checkSignature(rawBody: string, header: string | undefined): CapturedRequest["signature_check"] {
  if (!HMAC_KEY) return "no_key_set";
  if (!header) return "no_signature_header";

  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = createHmac("sha256", HMAC_KEY).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return "INVALID";
  return timingSafeEqual(a, b) ? "valid" : "INVALID";
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    console.error("[ring:capture] handler failed:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error" }));
    }
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawBody = await readRaw(req);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = SENSITIVE.has(key) ? "<redacted>" : Array.isArray(value) ? value.join(", ") : String(value ?? "");
  }

  let parsed: unknown;
  let parseError: string | undefined;
  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  // The header name is the thing we are here to learn, so find it by shape
  // rather than assuming "x-signature" — a wrong assumption here would look
  // like "Ring never signs anything".
  const signatureHeaderName = Object.keys(headers).find(
    (h) => h.includes("signature") || h.includes("hmac") || h.endsWith("-sign")
  );

  const record: CapturedRequest = {
    captured_at: new Date().toISOString(),
    method: req.method ?? "?",
    url: req.url ?? "/",
    headers,
    raw_body: rawBody,
    // Explicit null, never undefined: JSON.stringify drops undefined keys, so
    // a verification ping with no body would write a record missing the field
    // entirely and break whatever reads the file back.
    parsed_body: parsed ?? null,
    ...(parseError ? { json_parse_error: parseError } : {}),
    signature_check: checkSignature(rawBody, signatureHeaderName ? headers[signatureHeaderName] : undefined),
  };

  mkdirSync(dirname(CAPTURE_FILE), { recursive: true });
  appendFileSync(CAPTURE_FILE, `${JSON.stringify(record)}\n`, "utf8");

  console.log("\n" + "─".repeat(72));
  console.log(`[ring:capture] ${record.method} ${record.url}   ${record.captured_at}`);
  console.log(`  signature header : ${signatureHeaderName ?? "NONE FOUND — check the header dump below"}`);
  if (signatureHeaderName) console.log(`  signature value  : ${headers[signatureHeaderName]}`);
  console.log(`  signature check  : ${record.signature_check}`);
  if (record.signature_check === "no_key_set") {
    console.log("                     (set RING_HMAC_KEY in .env to verify it here)");
  }
  console.log("  all headers:");
  for (const [key, value] of Object.entries(headers)) console.log(`    ${key}: ${value}`);
  console.log(`  raw body (${rawBody.length} bytes):`);
  console.log(rawBody ? `    ${rawBody}` : "    <empty>");
  if (parsed !== undefined && parsed !== null) {
    console.log("  parsed:");
    console.log(JSON.stringify(parsed, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
  }
  console.log(`  appended to ${CAPTURE_FILE}`);

  // Always 200, whatever arrived. A portal verification ping that gets a 4xx
  // is usually recorded as a failed endpoint and has to be re-registered, so
  // this stays permissive on purpose — it is a listening post, not a gate.
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[ring:capture] listening on http://0.0.0.0:${PORT}`);
  console.log(`[ring:capture] writing to ${CAPTURE_FILE}`);
  console.log(
    HMAC_KEY
      ? "[ring:capture] RING_HMAC_KEY is set — signatures will be verified as they arrive"
      : "[ring:capture] RING_HMAC_KEY not set — signatures will be logged but not verified"
  );
  console.log("[ring:capture] every request is answered 200 {\"status\":\"ok\"}");
});
