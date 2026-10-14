import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { toAp2IntentMandate } from "@vouch/shared";
import type { RecordChange, VouchService } from "./service.ts";

/**
 * MCP resources and subscriptions (BUILD_PLAN.md T4).
 *
 * The record as addressable, read-only resources — the same data the tools
 * return, nothing a tool cannot already show — and the one thing tools
 * cannot do: tell a client when something changed, without being asked.
 *
 *   vouch://records/waiting          purchases held for the household (subscribe to this)
 *   vouch://records/{vouch_id}       one record
 *   vouch://mandates/{mandate_id}    one mandate
 *
 * For Alexa+ the waiting list is the natural subscription: a device can say
 * "a purchase needs your OK" the moment the gate holds one.
 */

export const WAITING_URI = "vouch://records/waiting";
const JSON_TYPE = "application/json";

const body = (uri: string, value: unknown) => ({
  contents: [{ uri, mimeType: JSON_TYPE, text: JSON.stringify(value, null, 2) }],
});

export function registerVouchResources(server: McpServer, service: VouchService, subscriptions: Set<string>): void {
  server.registerResource(
    "waiting",
    WAITING_URI,
    {
      title: "Waiting for the household",
      description: "Purchases the gate held. Subscribe to be told when one arrives or is decided.",
      mimeType: JSON_TYPE,
    },
    async (uri) => body(uri.href, service.listVouches({ limit: 200 }).filter((v) => v.action.status === "PendingApproval"))
  );

  server.registerResource(
    "record",
    new ResourceTemplate("vouch://records/{vouch_id}", { list: undefined }),
    { title: "A record", description: "One Vouch: what was attempted, every check, and what happened.", mimeType: JSON_TYPE },
    async (uri, { vouch_id }) => {
      const vouch = service.listVouches({ limit: 500 }).find((v) => v.vouch_id === String(vouch_id));
      if (!vouch) throw new Error(`No record "${String(vouch_id)}"`);
      return body(uri.href, vouch);
    }
  );

  server.registerResource(
    "mandate",
    new ResourceTemplate("vouch://mandates/{mandate_id}", {
      list: async () => ({
        resources: service.listMandates().map((m) => ({ uri: `vouch://mandates/${m.mandate_id}`, name: m.goal, mimeType: JSON_TYPE })),
      }),
    }),
    { title: "A mandate", description: "What the agent may do for one goal, and how careful it is right now.", mimeType: JSON_TYPE },
    async (uri, { mandate_id }) => {
      const mandate = service.getMandate(String(mandate_id));
      if (!mandate) throw new Error(`No mandate "${String(mandate_id)}"`);
      return body(uri.href, mandate);
    }
  );

  // Q1: the same mandate in AP2's Intent Mandate shape, plus what AP2 has no field for.
  server.registerResource(
    "ap2-intent-mandate",
    new ResourceTemplate("vouch://ap2/intent-mandates/{mandate_id}", { list: undefined }),
    {
      title: "As an AP2 Intent Mandate",
      description: "This mandate in the shape AP2 defines, with what AP2 cannot express kept beside it.",
      mimeType: JSON_TYPE,
    },
    async (uri, { mandate_id }) => {
      const mandate = service.getMandate(String(mandate_id));
      if (!mandate) throw new Error(`No mandate "${String(mandate_id)}"`);
      return body(uri.href, toAp2IntentMandate(mandate, service.currentTime()));
    }
  );

  // Subscriptions: the high-level server lists and reads; subscribing is the
  // low-level protocol's, so it is wired here, per session.
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscriptions.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });
}

/** The resource URIs a change to the record touches. */
export function urisFor(change: RecordChange): string[] {
  return [WAITING_URI, `vouch://records/${change.vouch_id}`, `vouch://mandates/${change.mandate_id}`];
}

/** Tells this session's client about a change, for the URIs it subscribed to. */
export function notifySubscribers(server: McpServer, subscriptions: Set<string>, change: RecordChange): void {
  for (const uri of urisFor(change)) {
    if (subscriptions.has(uri)) void server.server.sendResourceUpdated({ uri }).catch(() => undefined);
  }
}
