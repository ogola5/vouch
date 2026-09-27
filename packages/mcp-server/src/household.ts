import type { IncomingMessage, ServerResponse } from "node:http";
import type { VouchService } from "./service.ts";
import type { HouseholdAgent, NoticeResponse } from "./householdAgent.ts";
import type { Autonomy, Mandate } from "@vouch/shared";
import {
  PasskeyError,
  PasskeyRequired,
  verifyApproval,
  type PasskeyGuard,
  type PasskeyProof,
  type ProtectedAction,
} from "./passkey.ts";

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
const VOUCH_ACTION_PATH = /^\/household\/vouches\/([^/]+)\/(approve|dispute|decline)$/;
const ITEM_STATEMENT_PATH = /^\/household\/items\/([^/]+)\/statement$/;
const ITEM_RESPOND_PATH = /^\/household\/items\/([^/]+)\/respond$/;
const ITEM_MODE_PATH = /^\/household\/items\/([^/]+)\/mode$/;

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

const MODE_RANK: Record<Autonomy["mode"], number> = { remind: 0, ask: 1, auto: 2 };

/** More autonomy, or the same autonomy for longer. Delivery days are not authority. */
export function autonomyWidens(before: Autonomy, after: Autonomy): boolean {
  if (MODE_RANK[after.mode] > MODE_RANK[before.mode]) return true;
  if (after.mode === "auto" && before.mode === "auto" && before.until !== null) {
    return after.until === null || after.until > before.until;
  }
  return false;
}

/**
 * Would this edit let the agent do something it could not do before? Only
 * then does it need a passkey. Conservative on purpose: when unsure, it
 * counts as widening — asking for a fingerprint once too often is a far
 * smaller failure than letting authority widen unsigned.
 */
export function mandateEditWidens(before: Mandate, changes: Record<string, unknown>): boolean {
  const c = changes.constraints as Record<string, unknown> | undefined;
  if (c) {
    for (const key of ["max_price", "quantity"]) {
      const old = before.constraints[key];
      if (typeof old === "number" && (typeof c[key] !== "number" || (c[key] as number) > old)) return true;
    }
    for (const key of ["preferred_brand", "fallback_brand"]) {
      if (c[key] !== undefined && c[key] !== before.constraints[key]) return true;
    }
  }
  const rules = changes.requires_approval_if as string[] | undefined;
  if (rules && before.requires_approval_if.some((r) => !rules.includes(r))) return true;
  const threshold = changes.confidence_threshold;
  if (typeof threshold === "number" && threshold < before.confidence_threshold) return true;
  if (before.status === "paused" && changes.status === "active") return true;
  const autonomy = changes.autonomy as Partial<Autonomy> | undefined;
  if (autonomy && autonomyWidens(before.autonomy, { ...before.autonomy, ...autonomy })) return true;
  return false;
}

function proofFrom(body: Record<string, unknown>): PasskeyProof | undefined {
  const p = body.passkey as PasskeyProof | undefined;
  return p && typeof p === "object" ? p : undefined;
}

/**
 * Returns true when it handled the request.
 *
 * AUTHENTICATION: the household's powers that spend money or widen the
 * agent's authority require the household's passkey once one is registered
 * (passkey.ts). Before that, this surface is trusted because it is local —
 * it binds to 127.0.0.1 — and the README says so. A real deployment needs
 * an identity model for several household members, which is where the
 * multi-user story cut in BUILD_PLAN.md §2 would begin.
 */
export async function handleHouseholdRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: VouchService,
  pathname: string,
  agent?: HouseholdAgent,
  guard?: PasskeyGuard
): Promise<boolean> {
  const method = req.method ?? "GET";

  if (!pathname.startsWith(HOUSEHOLD_PREFIX)) return false;

  /** Enforces the passkey for a widening action; null when none is registered yet. */
  const requirePasskey = (action: ProtectedAction, description: string, body: Record<string, unknown>) =>
    guard ? guard.require(action, description, proofFrom(body)) : null;

  try {
    /* ---- passkeys ---- */
    if (guard && pathname === "/household/passkey" && method === "GET") {
      send(res, 200, { registered: guard.isRegistered(), rp_id: guard.rpId, origins: guard.origins });
      return true;
    }
    if (guard && pathname === "/household/passkey/register/options" && method === "POST") {
      send(res, 200, guard.registrationOptions());
      return true;
    }
    if (guard && pathname === "/household/passkey/register" && method === "POST") {
      const body = await readJson(req);
      const stored = guard.register({
        challenge_id: String(body.challenge_id),
        credential_id: String(body.credential_id),
        client_data_json: String(body.client_data_json),
        authenticator_data: String(body.authenticator_data),
        public_key: String(body.public_key),
        algorithm: Number(body.algorithm),
      });
      send(res, 200, { registered: true, credential_id: stored.credential_id });
      return true;
    }

    /*
     * The household model. Loading a household and moving its clock are demo
     * controls; "we're out" / "about half left" is information the household
     * gives. None of it is on the agent's MCP surface: an agent that could
     * fast-forward time or rewrite what is in the cupboard could manufacture
     * its own reasons to buy.
     */
    if (agent && pathname.startsWith("/household/pantry") && method === "GET") {
      send(res, 200, {
        today: agent.today(),
        date: agent.dateOf(agent.today()),
        set_up: agent.isSetUp(),
        items: agent.isSetUp() ? agent.pantry() : [],
      });
      return true;
    }
    if (agent && pathname === "/household/demo/setup" && method === "POST") {
      const items = agent.setUpDemo();
      send(res, 200, { today: agent.today(), date: agent.dateOf(agent.today()), set_up: true, items });
      return true;
    }
    if (agent && pathname === "/household/clock/advance" && method === "POST") {
      const body = await readJson(req);
      const days = Number(body.days ?? 1);
      if (!Number.isFinite(days) || days < 1) {
        send(res, 400, { error: "days must be a positive number" });
        return true;
      }
      send(res, 200, await agent.advance(days));
      return true;
    }
    const statementMatch = ITEM_STATEMENT_PATH.exec(pathname);
    if (agent && statementMatch && method === "POST") {
      const body = await readJson(req);
      const kind = body.kind;
      if (kind !== "runout" && kind !== "plenty" && kind !== "level") {
        send(res, 400, { error: 'kind must be "runout", "plenty" or "level"' });
        return true;
      }
      const statement =
        kind === "level"
          ? { kind: "level" as const, packs: Number(body.packs) }
          : { kind: kind === "runout" ? ("runout" as const) : ("plenty" as const) };
      send(res, 200, agent.record(decodeURIComponent(statementMatch[1]!), statement));
      return true;
    }
    const respondMatch = ITEM_RESPOND_PATH.exec(pathname);
    if (agent && respondMatch && method === "POST") {
      const body = await readJson(req);
      const simple = ["order", "not_yet", "accept_promotion", "decline_promotion"] as const;
      const response = simple.find((r) => r === body.response);
      const answer: NoticeResponse | null =
        body.response === "snooze"
          ? { response: "snooze", until_day: Number(body.until_day) }
          : response
            ? { response }
            : null;
      if (!answer) {
        send(res, 400, { error: 'response must be "order", "not_yet", "snooze", "accept_promotion" or "decline_promotion"' });
        return true;
      }
      const itemId = decodeURIComponent(respondMatch[1]!);
      if (answer.response === "accept_promotion") {
        // Handing an item over widens authority: passkey.
        const item = agent.pantry().find((p) => p.item_id === itemId);
        const until = item?.settings.promotion?.until;
        requirePasskey(
          { kind: "accept_handover", item_id: itemId },
          `Let your agent buy ${item?.name.toLowerCase() ?? itemId} on its own${until ? ` until ${until}` : ""}`,
          body
        );
      }
      send(res, 200, await agent.respond(itemId, answer));
      return true;
    }
    const modeMatch = ITEM_MODE_PATH.exec(pathname);
    if (agent && modeMatch && method === "POST") {
      const body = await readJson(req);
      const itemId = decodeURIComponent(modeMatch[1]!);
      const change: Record<string, unknown> = {};
      if (body.mode !== undefined) change.mode = body.mode;
      if (body.until !== undefined) change.until = body.until;
      if (body.delivery_days !== undefined) change.delivery_days = body.delivery_days;
      const item = agent.pantry().find((p) => p.item_id === itemId);
      if (item?.autonomy && autonomyWidens(item.autonomy, { ...item.autonomy, ...(change as Partial<Autonomy>) })) {
        const next = { ...item.autonomy, ...(change as Partial<Autonomy>) };
        requirePasskey(
          { kind: "set_autonomy", item_id: itemId, change },
          `Let your agent buy ${item.name.toLowerCase()} on its own${next.until ? ` until ${next.until}` : ""}`,
          body
        );
      }
      send(res, 200, agent.setItemMode(itemId, change));
      return true;
    }

    /*
     * The tamper-evident record, checked end to end: the chain, every Vouch
     * against its history, and every passkey approval — its signature, and
     * the chain entry it anchored. A consistent rewrite of the whole ledger
     * passes the first two checks; it cannot pass the third without the
     * household's private key.
     */
    if (method === "GET" && pathname === "/household/record") {
      const report = service.verifyLedger();
      const problems = [...report.problems];
      let approvals = 0;
      const keys = guard?.passkeys() ?? [];
      for (const v of service.listVouches({ limit: 1000 })) {
        const a = v.household_approval;
        if (!a || !a.nonce) continue;
        approvals++;
        const key = keys.find((k) => k.credential_id === a.credential_id);
        const check = key ? verifyApproval(key, { ...a, nonce: a.nonce }) : { ok: false as const, problem: "its passkey is not on file" };
        if (!check.ok) problems.push({ vouch_id: v.vouch_id, problem: `its passkey approval fails: ${check.problem}` });
        let anchor: { seq: number; hash: string } | null = null;
        try {
          anchor = (JSON.parse(a.action) as { chain_head?: { seq: number; hash: string } | null }).chain_head ?? null;
        } catch {
          /* reported by the signature check */
        }
        if (anchor && service.ledgerEntry(anchor.seq)?.hash !== anchor.hash) {
          problems.push({
            seq: anchor.seq,
            problem: `the history up to this entry was rewritten after the household approved ${v.decision.product} with its passkey`,
          });
        }
      }
      send(res, 200, { ...report, ok: problems.length === 0, problems, approvals_checked: approvals });
      return true;
    }
    if (pathname === "/household/demo/tamper" && method === "POST") {
      // DEMO CONTROL: edit an old record the way someone with database access
      // might, so the console can show it being caught. Named as a demo.
      const body = await readJson(req);
      const target =
        typeof body.vouch_id === "string"
          ? body.vouch_id
          : service.listVouches({ limit: 1000 }).reverse().find((v) => v.action.status === "Complete")?.vouch_id;
      if (!target) {
        send(res, 400, { error: "No completed purchase to tamper with yet" });
        return true;
      }
      const before = service.listVouches({ limit: 1000 }).find((v) => v.vouch_id === target)!;
      const price = typeof body.price === "number" ? body.price : Math.round((before.decision.price ?? 0) * 50) / 100;
      service.tamperForDemo(target, price);
      send(res, 200, { vouch_id: target, price_was: before.decision.price, price_now: price });
      return true;
    }

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
      const { passkey: _proof, ...changes } = await readJson(req);
      const before = service.getMandate(id);
      if (before && mandateEditWidens(before, changes)) {
        requirePasskey(
          { kind: "edit_mandate", mandate_id: id, changes },
          `Let your agent do more for "${before.goal}"`,
          { passkey: _proof }
        );
      }
      send(res, 200, service.updateMandate(id, changes));
      return true;
    }

    const actionMatch = VOUCH_ACTION_PATH.exec(pathname);
    if (actionMatch && method === "POST") {
      const [, vouchId, action] = actionMatch;
      const body = await readJson(req);

      if (action === "approve") {
        // Spends money the gate refused to spend: passkey, bound to THIS Vouch.
        const held = service.listVouches({ limit: 200 }).find((v) => v.vouch_id === vouchId);
        const approval = requirePasskey(
          // Signing the record's latest entry anchors all history before it.
          { kind: "approve_purchase", vouch_id: vouchId!, chain_head: service.ledgerHead() },
          held
            ? `Approve ${held.decision.product}${held.decision.price !== null ? ` — $${held.decision.price.toFixed(2)}` : ""}`
            : `Approve purchase ${vouchId}`,
          body
        );
        send(res, 200, await service.approvePurchase(vouchId!, approval));
        return true;
      }

      if (action === "decline") {
        // "Keep it blocked" only narrows — the parked checkout is cancelled.
        // No passkey, by the same rule that lets a dispute through.
        send(res, 200, await service.declinePurchase(vouchId!, typeof body.reason === "string" ? body.reason : undefined));
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
    if (error instanceof PasskeyRequired && guard) {
      // Refuse, and hand back a fresh challenge for exactly this action: the
      // page signs what the server names, rather than composing the action
      // itself and possibly getting it subtly different.
      send(res, 401, { error: error.message, needs_passkey: true, ...guard.actionChallenge(error.action, error.description) });
      return true;
    }
    if (error instanceof PasskeyError) {
      send(res, error.status, { error: error.message });
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    send(res, 400, { error: message });
    return true;
  }
}
