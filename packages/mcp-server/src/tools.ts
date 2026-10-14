import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
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

/**
 * MCP tool annotations (BUILD_PLAN.md T2): the hints a client — Alexa+ among
 * them — uses to decide what to run freely and what to confirm with a person.
 * In one table so they can be reviewed together. Hints, not guarantees: the
 * guarantees are the gate and the absent approval tool.
 *
 *   readOnly     changes nothing
 *   destructive  can do something that is not simply undone
 *   idempotent   calling twice with the same arguments does no more than once
 *   openWorld    reaches outside Vouch (the merchant)
 */
const HINTS = {
  create_mandate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  get_mandate: { readOnlyHint: true, openWorldHint: false },
  list_mandates: { readOnlyHint: true, openWorldHint: false },
  // Pausing only removes authority, and pausing twice is pausing once.
  pause_mandate: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search_catalog: { readOnlyHint: true, openWorldHint: true },
  // Can place a real order with an outside merchant: the one a client should confirm.
  propose_purchase: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // Narrows authority; a second dispute of the same Vouch is refused, not repeated.
  record_dispute: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  list_vouches: { readOnlyHint: true, openWorldHint: false },
  // Reads the record; the model it may call only rewords that record's own facts.
  explain_vouch: { readOnlyHint: true, openWorldHint: false },
} satisfies Record<string, ToolAnnotations>;

/** MCP content blocks are text; structured payloads go through as pretty JSON. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/*
 * Structured outputs (BUILD_PLAN.md T3). For the tools whose results a client
 * acts on, the result is ALSO returned as typed `structuredContent` matching a
 * declared `outputSchema` — so a client reads `outcome` instead of parsing
 * JSON out of a sentence, and both ends validate it. The text stays exactly
 * as it was, for clients that read text (the Strands agent, older clients).
 *
 * Record shapes name the fields a client relies on and allow the rest
 * (passthrough), so adding a field to a Vouch never breaks the contract.
 */
function structured(data: object, textValue: unknown = data) {
  return { ...json(textValue), structuredContent: data as Record<string, unknown> };
}

const VouchOut = z
  .object({
    vouch_id: z.string(),
    action: z.object({ status: z.string(), ucp_session_id: z.string().nullable() }).passthrough(),
    decision: z.object({ product: z.string(), price: z.number().nullable(), reason: z.array(z.string()) }).passthrough(),
    authority: z
      .object({ mandate_id: z.string(), within_bounds: z.boolean(), triggered_rules: z.array(z.string()) })
      .passthrough(),
  })
  .passthrough();

const MandateOut = z
  .object({ mandate_id: z.string(), goal: z.string(), confidence_threshold: z.number(), status: z.string() })
  .passthrough();

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
      annotations: HINTS.create_mandate,
      description:
        "Turn a household's plain-language standing instruction (\"keep detergent stocked, " +
        "under $15, monthly\") into a structured authority boundary that every later purchase " +
        "is gated against. Constraint prices are in major units (15 means $15.00).",
      inputSchema: {
        goal: z.string().describe('e.g. "Keep laundry detergent stocked"'),
        /*
         * Named keys, not an open map. With `z.record(...)` the model had to
         * GUESS key names, and measured live (2026-09-28) it wrote
         * fallback_brands: ["Brand B"] — rejected — then dropped the fallback
         * brand on the retry, saving a mandate that forgot what the household
         * said. Named keys put `fallback_brand` in the tool definition itself.
         */
        constraints: z
          .object({
            max_price: z.number().positive().optional().describe("Highest price per unit, in dollars: 15 means $15.00"),
            quantity: z.number().int().positive().optional().describe("Most units in one purchase"),
            preferred_brand: z.string().optional().describe("The ONE brand the household prefers"),
            fallback_brand: z.string().optional().describe("The ONE brand that is fine when the preferred one is not"),
            frequency: z.string().optional().describe('How often, as an ISO 8601 duration: "P1M" is monthly'),
          })
          .catchall(z.union([z.string(), z.number(), z.boolean()]))
          .describe('e.g. { "max_price": 15, "preferred_brand": "Brand A", "fallback_brand": "Brand B", "frequency": "P1M" }'),
        requires_approval_if: z
          .array(z.string())
          .describe(
            'Write these literally — the numbers belong in constraints, not in the rule. Only these are ' +
              'accepted: "price > max_price" (never "price > 15"), "new_brand", and a quantity limit with a real ' +
              'whole number, e.g. "quantity > 2". Anything else is rejected.'
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
        // Fields named one by one: the service also accepts `autonomy`, which
        // is household-only. A mandate an agent writes starts in "ask", so an
        // agent cannot create itself the power to buy unprompted.
        return json(
          service.createMandate({
            mandate_id: args.mandate_id,
            goal: args.goal,
            constraints: args.constraints,
            requires_approval_if: args.requires_approval_if,
            authority_type: args.authority_type,
            confidence_threshold: args.confidence_threshold,
          })
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "get_mandate",
    {
      title: "Get a mandate",
      annotations: HINTS.get_mandate,
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
    {
      title: "List mandates",
      annotations: HINTS.list_mandates,
      description: "Every mandate this household has set, oldest first.",
      outputSchema: { mandates: z.array(MandateOut) },
    },
    async () => {
      const mandates = service.listMandates();
      return structured({ mandates }, mandates);
    }
  );

  server.registerTool(
    "pause_mandate",
    {
      title: "Pause or resume a mandate",
      annotations: HINTS.pause_mandate,
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
      annotations: HINTS.search_catalog,
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
      outputSchema: {
        products: z.array(
          z.object({ product_id: z.string(), title: z.string(), brand: z.string(), price: z.number(), currency: z.string() })
        ),
      },
    },
    async ({ query }) => {
      try {
        const products = await service.searchCatalog(query);
        return structured({ products }, products);
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
      annotations: HINTS.propose_purchase,
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
            "How sure you are this purchase serves the mandate's goal. Be honest: the gate compares " +
              "a confidence built from evidence (need, usual product, price history) against the " +
              "mandate's threshold, and your number can only LOWER that, never raise it."
          ),
        reason: z
          .array(z.string())
          .describe('Why you chose this, e.g. ["price_drop", "preferred_brand"]'),
      },
      outputSchema: {
        outcome: z.enum(["completed", "held_for_approval"]),
        /** "completed", or "ready_for_complete" for a held purchase: one call short of an order. */
        session_status: z.string(),
        explanation: z.string(),
        vouch: VouchOut,
        evaluation: z
          .object({ withinBounds: z.boolean(), requiresApproval: z.boolean(), triggeredRules: z.array(z.string()) })
          .passthrough(),
      },
    },
    async (args, extra) => {
      try {
        // Fields named one by one, not `args` passed through: the service also
        // accepts an internal `household` context ("the forecast says we need
        // this") that only HouseholdAgent may set. An agent must not be able
        // to claim it, even if a schema change ever stopped stripping extras.
        return structured(
          await service.proposePurchase({
            mandate_id: args.mandate_id,
            product_id: args.product_id,
            quantity: args.quantity,
            brand: args.brand,
            confidence: args.confidence,
            reason: args.reason,
            // Set here, from the transport — never from the agent's arguments.
            origin: { started_by: "mcp_tool", mcp_request_id: String(extra.requestId) },
          })
        );
      } catch (error) {
        return failure(error);
      }
    }
  );

  /*
   * NO approve_purchase TOOL — REMOVED DELIBERATELY, do not add it back.
   *
   * It was here, and a live run showed why it should not be: an agent whose
   * purchase is held can simply approve it, and the resulting Vouch records
   * `approved_by_household` — a statement that would then be false. The
   * household's record would show consent that was never given, which is the
   * one lie this whole project exists to make impossible.
   *
   * Approval now lives on the household surface only (household.ts,
   * POST /household/vouches/:id/approve). The rule: the agent may do anything
   * that cannot increase its own authority. Approving a refusal increases it.
   *
   * The system prompt used to tell the model not to do this. A prompt is a
   * request; an absent tool is a guarantee.
   */

  /* ---------------------------------------------------------------------
   * The adaptive loop
   * ------------------------------------------------------------------ */

  server.registerTool(
    "record_dispute",
    {
      title: "Dispute a vouch",
      annotations: HINTS.record_dispute,
      description:
        'The household says "I didn\'t want that". Records the dispute on the Vouch and tightens ' +
        "the mandate's confidence_threshold, so the next borderline proposal in this category is " +
        "held where an identical one previously passed. Returns the before and after threshold.",
      inputSchema: {
        vouch_id: z.string(),
        reason: z.string().optional(),
      },
      outputSchema: {
        threshold_before: z.number(),
        threshold_after: z.number(),
        rationale: z.string(),
        vouch: VouchOut,
        mandate: MandateOut,
      },
    },
    async (args) => {
      try {
        return structured(await service.recordDispute(args));
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
      annotations: HINTS.list_vouches,
      description:
        'The household\'s record of what the agent did — answers "what did you buy me this month". ' +
        "Newest first. Includes held and disputed actions, not just completed purchases.",
      inputSchema: {
        mandate_id: z.string().optional(),
        since: z.string().optional().describe("ISO 8601 lower bound on created_at"),
        limit: z.number().int().positive().max(500).optional(),
      },
      outputSchema: { vouches: z.array(VouchOut) },
    },
    async (args) => {
      const vouches = service.listVouches(args);
      return structured({ vouches }, vouches);
    }
  );

  server.registerTool(
    "explain_vouch",
    {
      title: "Explain a vouch",
      annotations: HINTS.explain_vouch,
      description:
        'Plain-language account of one action — answers "why did you buy this" and "why didn\'t ' +
        'you buy the $27 one". For a held purchase it names the boundary that stopped it.',
      inputSchema: { vouch_id: z.string() },
      outputSchema: {
        text: z.string(),
        /** Who wrote it: the model (checked against the record) or the fixed wording. */
        source: z.enum(["model", "rules"]),
        fallback_reason: z.string().optional(),
      },
    },
    async ({ vouch_id }) => {
      try {
        const e = await service.explainVouch(vouch_id);
        // The last line says who wrote it, so neither the household nor the
        // chat can mistake a fixed template for a model, or the reverse.
        const source =
          e.source === "model"
            ? "(Written by the model from this record's facts, and checked against them.)"
            : e.fallback_reason
              ? `(Fixed wording from the record — the model's text was set aside: ${e.fallback_reason}.)`
              : "(Fixed wording from the record.)";
        return {
          content: [{ type: "text" as const, text: e.text }, { type: "text" as const, text: source }],
          structuredContent: { text: e.text, source: e.source, ...(e.fallback_reason ? { fallback_reason: e.fallback_reason } : {}) },
        };
      } catch (error) {
        return failure(error);
      }
    }
  );
}
