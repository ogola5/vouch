import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { RING_SIGNATURE_HEADER } from "./types.ts";
import { parseRingWebhook, RingWebhookParseError, verifyRingSignature } from "./webhook.ts";
import type { RingEventStore } from "./realProvider.ts";

/**
 * The receiving end of the Ring integration: verify, parse, store.
 *
 * Kept separate from `scripts/capture.ts`. That one is a listening post that
 * accepts anything in order to discover what Ring sends; this one is the real
 * receiver and rejects what it cannot verify. Merging them would mean the
 * production path inheriting "accept everything", which is the opposite of
 * what it is for.
 */

export interface RingWebhookServerOptions {
  store: RingEventStore;
  /** The HMAC key from the Ring portal. Absent means every delivery is rejected. */
  secret: string | undefined;
  /** Path Ring posts to. */
  path?: string;
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createRingWebhookServer(options: RingWebhookServerOptions): Server {
  const path = options.path ?? "/ring/webhook";

  return createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { status: "error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== path || req.method !== "POST") {
      send(res, 404, { status: "not_found" });
      return;
    }

    // Read the RAW bytes and verify before parsing. Verifying a re-serialised
    // body would fail on every genuine delivery, because key order and
    // whitespace change with it.
    const rawBody = await readRaw(req);
    const header = req.headers[RING_SIGNATURE_HEADER];
    const signature = Array.isArray(header) ? header[0] : header;

    const check = verifyRingSignature(rawBody, signature, options.secret);
    if (!check.valid) {
      // 401 and nothing else. No detail about WHY it failed: telling an
      // unauthenticated caller whether the header was missing, malformed or
      // simply wrong hands them a way to probe the secret.
      send(res, 401, { status: "unauthorized" });
      return;
    }

    try {
      options.store.add(parseRingWebhook(rawBody));
    } catch (error) {
      if (error instanceof RingWebhookParseError) {
        // Signed but unparseable. 400, and it is worth logging loudly: a
        // correctly signed body we cannot read means Ring changed the shape
        // and the types in this package are now wrong.
        console.error(`[ring] signed delivery did not parse — check types.ts: ${error.message}`);
        send(res, 400, { status: "bad_payload" });
        return;
      }
      throw error;
    }

    send(res, 200, { status: "ok" });
  }
}
