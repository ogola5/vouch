import type { IncomingMessage, ServerResponse } from "node:http";
import type { VouchService } from "./service.ts";

/**
 * The HOUSEHOLD's surface, deliberately separate from the agent's MCP tools.
 *
 * Two surfaces over one service, with different powers. The rule that decides
 * which side a capability lands on:
 *
 *   The agent may do anything that cannot increase its own authority.
 *
 * So `record_dispute` is on BOTH — a dispute only ever tightens the mandate,
 * which means an agent that could forge one could only harm itself, and
 * relaying "I didn't want that" from a conversation is a legitimate thing for
 * an agent to do.
 *
 * Whereas `approve_purchase` and `update_mandate` are HERE ONLY. Both widen
 * what the agent may do next: approval turns a refusal into an order, and
 * editing a mandate raises the ceiling the gate checks against. An agent
 * holding either could grant itself whatever the gate just denied, and every
 * guarantee in this project would be decoration. This is the same reasoning
 * that keeps `complete_checkout` off the toolset — the containment is
 * structural, not a matter of the model being well behaved.
 *
 * It matters that this is a *different surface* and not a flag on the same
 * tool. A flag would have to be checked; an absent tool cannot be called.
 */

export const HOUSEHOLD_PREFIX = "/household";

const MANDATE_PATH = /^\/household\/mandates\/([^/]+)$/;
const VOUCH_ACTION_PATH = /^\/household\/vouches\/([^/]+)\/(approve|dispute)$/;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/**
 * Returns true when it handled the request. There is no authentication here
 * yet, and saying so plainly matters more than pretending otherwise: the
 * server binds to 127.0.0.1 and the household surface is trusted because it
 * is local. A real deployment needs an identity model — which is also where
 * the household multi-user story cut in BUILD_PLAN.md §2 would begin.
 */
export async function handleHouseholdRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: VouchService,
  pathname: string
): Promise<boolean> {
  const method = req.method ?? "GET";

  if (!pathname.startsWith(HOUSEHOLD_PREFIX)) return false;

  try {
    if (method === "GET" && pathname === "/household/state") {
      send(res, 200, {
        mandates: service.listMandates(),
        vouches: service.listVouches({ limit: 50 }),
      });
      return true;
    }

    const mandateMatch = MANDATE_PATH.exec(pathname);
    if (mandateMatch && method === "PATCH") {
      const id = mandateMatch[1]!;
      const body = await readJson(req);
      send(res, 200, service.updateMandate(id, body));
      return true;
    }

    const actionMatch = VOUCH_ACTION_PATH.exec(pathname);
    if (actionMatch && method === "POST") {
      const [, vouchId, action] = actionMatch;
      const body = await readJson(req);

      if (action === "approve") {
        send(res, 200, await service.approvePurchase(vouchId!));
        return true;
      }

      send(
        res,
        200,
        await service.recordDispute({
          vouch_id: vouchId!,
          reason: typeof body.reason === "string" ? body.reason : undefined,
        })
      );
      return true;
    }

    send(res, 404, { error: `No household route for ${method} ${pathname}` });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, 400, { error: message });
    return true;
  }
}
