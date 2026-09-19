import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VouchService } from "./service.ts";

/**
 * Vouch's MCP tool surface — a thin adapter over VouchService.
 *
 * These are deliberately NOT the UCP MCP binding's tool names. UCP fixes
 * those (search_catalog, create_cart, create_checkout, complete_checkout,
 * get_order) and they belong to the merchant. Vouch's tools are the
 * household trust layer in front of a merchant, which is why the names are
 * about authority and accountability rather than carts. Keeping the two
 * vocabularies distinct is what makes the layering legible in a walkthrough.
 *
 * Note what is absent: there is no tool that completes a checkout directly.
 * The only path to an order is propose_purchase (which gates) or
 * approve_purchase (which requires a human's yes on an already-held vouch).
 * An orchestrator holding this toolset cannot route around the mandate,
 * which is the structural version of the brief's "real gate, not a caption".
 */

/** MCP content blocks are text; structured payloads go through as pretty JSON. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function registerVouchTools(server: McpServer, service: VouchService): void {
  /* ---------------------------------------------------------------------
   * Mandates
   * ------------------------------------------------------------------ */

  server.registerTool(
    "create_mandate",
    {
      title: "Create a mandate",
      description:
        "Turn a household's plain-language standing instruction (\"keep detergent stocked, " +
        "under $15, monthly\") into a structured authority boundary that every later purchase " +
        "is gated against. Constraint prices are in major units (15 means $15.00).",
      inputSchema: {
        goal: z.string().describe('e.g. "Keep laundry detergent stocked"'),
        constraints: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .describe(
            'e.g. { "max_price": 15, "quantity": 2, "frequency": "P1M", "preferred_brand": "Brand A" }'
          ),
        requires_approval_if: z
          .array(z.string())
          .describe(
            'Rule expressions the gate understands: "price > max_price", "new_brand", "quantity > N". ' +
              "Anything else is treated as always-triggered, so the agent fails closed."
          ),
        authority_type: z.enum(["explicit", "delegated", "inferred"]),
        mandate_id: z.string().optional(),
        confidence_threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("How sure the agent must be before acting unsupervised. Defaults to 0.85."),
      },
    },
    async (args) => {
      try {
        return json(service.createMandate(args));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "get_mandate",
    {
      title: "Get a mandate",
      description:
        "Fetch one mandate, including its current confidence_threshold and history. Use this to " +
        "answer \"what am I allowed to do\" and to show before/after state when authority changes.",
      inputSchema: { mandate_id: z.string() },
    },
    async ({ mandate_id }) => {
      const mandate = service.getMandate(mandate_id);
      return mandate ? json(mandate) : failure(new Error(`No mandate with id "${mandate_id}"`));
    }
  );

  server.registerTool(
    "list_mandates",
    { title: "List mandates", description: "Every mandate this household has set, oldest first." },
    async () => json(service.listMandates())
  );

  server.registerTool(
    "pause_mandate",
    {
      title: "Pause or resume a mandate",
      description:
        "Pausing suspends the agent's authority without deleting the mandate — a paused mandate " +
        "holds every proposal for approval rather than silently allowing them.",
      inputSchema: { mandate_id: z.string(), paused: z.boolean() },
    },
    async ({ mandate_id, paused }) => {
      try {
        return json(paused ? service.pauseMandate(mandate_id) : service.resumeMandate(mandate_id));
      } catch (error) {
        return failure(error);
      }
    }
  );

  /* ---------------------------------------------------------------------
   * Discovery
   * ------------------------------------------------------------------ */

  server.registerTool(
    "search_catalog",
    {
      title: "See what the merchant sells",
      description:
        "Find real products and their current prices. Call this BEFORE propose_purchase — " +
        "product_id must be an id returned here, and guessing one will fail. Prices are in " +
        "dollars, the same units a mandate's max_price uses, so they can be compared directly.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Optional filter matched against id, title and brand. Omit to list everything."),
      },
    },
    async ({ query }) => {
      try {
        return json(await service.searchCatalog(query));
      } catch (error) {
        return failure(error);
      }
    }
  );

  /* ---------------------------------------------------------------------
   * THE GATE
   * ------------------------------------------------------------------ */

  server.registerTool(
    "propose_purchase",
    {
      title: "Propose a purchase (gated)",
      description:
        "The only way to buy anything. Opens a real UCP checkout session, brings it to " +
        "ready_for_complete, then checks the mandate BEFORE placing the order. If the proposal " +
        "is outside the mandate's bounds the session is left unplaced and a Vouch is recorded " +
        "with status PendingApproval and the rules that stopped it. Price is read from the " +
        "merchant, not from you.",
      inputSchema: {
        mandate_id: z.string(),
        product_id: z
          .string()
          .describe(
            'An id from search_catalog, e.g. "detergent-brand-a". Do not guess or construct ' +
              "one — call search_catalog first."
          ),
        quantity: z.number().int().positive(),
        brand: z.string().describe("Brand as found in the catalog; feeds the new_brand rule."),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe(
            "How sure you are this purchase serves the mandate's goal. Required: it is compared " +
              "against the mandate's confidence_threshold, which disputes tighten over time."
          ),
        reason: z
          .array(z.string())
          .describe('Why you chose this, e.g. ["price_drop", "preferred_brand"]'),
      },
    },
    async (args) => {
      try {
        return json(await service.proposePurchase(args));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "approve_purchase",
    {
      title: "Approve a held purchase",
      description:
        "Complete a purchase the gate held, after the household has said yes. Only works on a " +
        "Vouch in PendingApproval — it cannot be used to skip the gate on a new proposal.",
      inputSchema: { vouch_id: z.string() },
    },
    async ({ vouch_id }) => {
      try {
        return json(await service.approvePurchase(vouch_id));
      } catch (error) {
        return failure(error);
      }
    }
  );

  /* ---------------------------------------------------------------------
   * The adaptive loop
   * ------------------------------------------------------------------ */

  server.registerTool(
    "record_dispute",
    {
      title: "Dispute a vouch",
      description:
        'The household says "I didn\'t want that". Records the dispute on the Vouch and tightens ' +
        "the mandate's confidence_threshold, so the next borderline proposal in this category is " +
        "held where an identical one previously passed. Returns the before and after threshold.",
      inputSchema: {
        vouch_id: z.string(),
        reason: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return json(await service.recordDispute(args));
      } catch (error) {
        return failure(error);
      }
    }
  );

  /* ---------------------------------------------------------------------
   * Queries
   * ------------------------------------------------------------------ */

  server.registerTool(
    "list_vouches",
    {
      title: "List vouches",
      description:
        'The household\'s record of what the agent did — answers "what did you buy me this month". ' +
        "Newest first. Includes held and disputed actions, not just completed purchases.",
      inputSchema: {
        mandate_id: z.string().optional(),
        since: z.string().optional().describe("ISO 8601 lower bound on created_at"),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async (args) => json(service.listVouches(args))
  );

  server.registerTool(
    "explain_vouch",
    {
      title: "Explain a vouch",
      description:
        'Plain-language account of one action — answers "why did you buy this" and "why didn\'t ' +
        'you buy the $27 one". For a held purchase it names the boundary that stopped it.',
      inputSchema: { vouch_id: z.string() },
    },
    async ({ vouch_id }) => {
      try {
        return { content: [{ type: "text" as const, text: await service.explainVouch(vouch_id) }] };
      } catch (error) {
        return failure(error);
      }
    }
  );
}
