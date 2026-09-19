import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Mandate, Vouch } from "@vouch/shared";
import { SCHEMA_SQL } from "./schema.ts";

/**
 * Persistence for the three objects the demo has to survive a restart with:
 * mandates, vouches and disputes.
 *
 * Every read re-parses the stored JSON through the Zod schema rather than
 * casting it. That costs a little per row and is worth it here: the adaptive
 * loop's whole claim is that a mandate's authority *changed*, so a silently
 * malformed mandate row would undermine exactly the thing the demo is
 * showing. Failing loudly on read is the same fail-closed instinct the gate
 * in packages/shared/src/gate.ts applies to unrecognized rules.
 */

export interface DisputeRecord {
  dispute_id: string;
  vouch_id: string;
  mandate_id: string;
  disputed_at: string;
  reason: string | null;
  confidence_threshold_delta: number | null;
  threshold_before: number;
  threshold_after: number;
}

export interface ListVouchesFilter {
  mandate_id?: string;
  /** Inclusive ISO 8601 lower bound on created_at, for "this month" queries. */
  since?: string;
  limit?: number;
}

/**
 * The outcome of applying a reasoning provider's threshold adjustment. Both
 * the before and after value are returned because the Fire TV surface shows
 * the mandate's before/after state (brief section 8, step 5) and should not
 * have to have snapshotted it beforehand.
 */
export interface ThresholdChange {
  mandate: Mandate;
  threshold_before: number;
  threshold_after: number;
}

export class VouchStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** `:memory:` gives an isolated database per call, which is what tests want. */
  static open(location = ":memory:"): VouchStore {
    const db = new DatabaseSync(location);
    db.exec(SCHEMA_SQL);
    return new VouchStore(db);
  }

  close(): void {
    this.db.close();
  }

  /* ---------------------------------------------------------------------
   * Mandates
   * ------------------------------------------------------------------ */

  saveMandate(mandate: Mandate): Mandate {
    const parsed = Mandate.parse(mandate);
    this.db
      .prepare(
        `INSERT INTO mandates (mandate_id, status, confidence_threshold, created_at, updated_at, doc)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (mandate_id) DO UPDATE SET
           status               = excluded.status,
           confidence_threshold = excluded.confidence_threshold,
           updated_at           = excluded.updated_at,
           doc                  = excluded.doc`
      )
      .run(
        parsed.mandate_id,
        parsed.status,
        parsed.confidence_threshold,
        parsed.created_at,
        parsed.updated_at,
        JSON.stringify(parsed)
      );
    return parsed;
  }

  getMandate(mandateId: string): Mandate | null {
    const row = this.db
      .prepare(`SELECT doc FROM mandates WHERE mandate_id = ?`)
      .get(mandateId) as { doc: string } | undefined;
    return row ? Mandate.parse(JSON.parse(row.doc)) : null;
  }

  listMandates(): Mandate[] {
    const rows = this.db
      .prepare(`SELECT doc FROM mandates ORDER BY created_at ASC`)
      .all() as { doc: string }[];
    return rows.map((r) => Mandate.parse(JSON.parse(r.doc)));
  }

  setMandateStatus(mandateId: string, status: Mandate["status"]): Mandate {
    const mandate = this.requireMandate(mandateId);
    return this.saveMandate({ ...mandate, status, updated_at: new Date().toISOString() });
  }

  /* ---------------------------------------------------------------------
   * Vouches
   * ------------------------------------------------------------------ */

  saveVouch(vouch: Vouch): Vouch {
    const parsed = Vouch.parse(vouch);
    this.db
      .prepare(
        `INSERT INTO vouches (vouch_id, mandate_id, created_at, action_status, within_bounds, doc)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (vouch_id) DO UPDATE SET
           action_status = excluded.action_status,
           within_bounds = excluded.within_bounds,
           doc           = excluded.doc`
      )
      .run(
        parsed.vouch_id,
        parsed.authority.mandate_id,
        parsed.created_at,
        parsed.action.status,
        parsed.authority.within_bounds ? 1 : 0,
        JSON.stringify(parsed)
      );
    return parsed;
  }

  getVouch(vouchId: string): Vouch | null {
    const row = this.db
      .prepare(`SELECT doc FROM vouches WHERE vouch_id = ?`)
      .get(vouchId) as { doc: string } | undefined;
    return row ? Vouch.parse(JSON.parse(row.doc)) : null;
  }

  /**
   * Newest first, because every caller — the Fire TV dashboard and the
   * week-4 "what did you buy me this month" query — wants recent activity.
   */
  listVouches(filter: ListVouchesFilter = {}): Vouch[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (filter.mandate_id !== undefined) {
      where.push(`mandate_id = ?`);
      params.push(filter.mandate_id);
    }
    if (filter.since !== undefined) {
      where.push(`created_at >= ?`);
      params.push(filter.since);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT doc FROM vouches ${clause} ORDER BY created_at DESC, vouch_id DESC LIMIT ?`)
      .all(...params, limit) as { doc: string }[];
    return rows.map((r) => Vouch.parse(JSON.parse(r.doc)));
  }

  /* ---------------------------------------------------------------------
   * Disputes — the adaptive loop's write path
   * ------------------------------------------------------------------ */

  /**
   * Records a dispute against a vouch and moves its mandate's authority in
   * one transaction. These are one operation, not two: a dispute that landed
   * without tightening the mandate would leave the system claiming an
   * adjustment happened when it did not, which is the single thing the demo
   * is built to show. The caller supplies `newThreshold` and `delta` from
   * ReasoningProvider.adjustConfidenceThreshold — this layer persists that
   * decision, it does not make it.
   */
  recordDispute(input: {
    vouch_id: string;
    reason?: string;
    newThreshold: number;
    delta: number;
  }): { vouch: Vouch; change: ThresholdChange; dispute: DisputeRecord } {
    return this.transaction(() => {
      const vouch = this.getVouch(input.vouch_id);
      if (!vouch) {
        throw new Error(`No vouch with id "${input.vouch_id}"`);
      }
      if (vouch.dispute !== null) {
        throw new Error(
          `Vouch "${input.vouch_id}" is already disputed (at ${vouch.dispute.disputed_at}). ` +
            `Re-disputing would tighten the mandate twice for one complaint.`
        );
      }

      const mandate = this.requireMandate(vouch.authority.mandate_id);
      const now = new Date().toISOString();
      const thresholdBefore = mandate.confidence_threshold;

      const updatedMandate = this.saveMandate({
        ...mandate,
        confidence_threshold: input.newThreshold,
        history: {
          ...mandate.history,
          disputed_actions: mandate.history.disputed_actions + 1,
          last_adjusted: now,
        },
        updated_at: now,
      });

      const updatedVouch = this.saveVouch({
        ...vouch,
        dispute: {
          disputed_at: now,
          reason: input.reason,
          confidence_threshold_delta: input.delta,
        },
      });

      const dispute: DisputeRecord = {
        dispute_id: randomUUID(),
        vouch_id: vouch.vouch_id,
        mandate_id: mandate.mandate_id,
        disputed_at: now,
        reason: input.reason ?? null,
        confidence_threshold_delta: input.delta,
        threshold_before: thresholdBefore,
        threshold_after: updatedMandate.confidence_threshold,
      };

      this.db
        .prepare(
          `INSERT INTO disputes (dispute_id, vouch_id, mandate_id, disputed_at, reason,
                                 confidence_threshold_delta, threshold_before, threshold_after)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          dispute.dispute_id,
          dispute.vouch_id,
          dispute.mandate_id,
          dispute.disputed_at,
          dispute.reason,
          dispute.confidence_threshold_delta,
          dispute.threshold_before,
          dispute.threshold_after
        );

      return {
        vouch: updatedVouch,
        change: {
          mandate: updatedMandate,
          threshold_before: thresholdBefore,
          threshold_after: updatedMandate.confidence_threshold,
        },
        dispute,
      };
    });
  }

  /**
   * The recovery half of the loop: an undisputed action loosens the mandate
   * back toward its original threshold. Separate from recordDispute because
   * it has no vouch-level record to write — nothing was complained about —
   * and because `undisputed_actions` is the counter the reasoning provider
   * reads to decide how far a streak has earned back.
   */
  applyUndisputedAction(input: {
    mandate_id: string;
    newThreshold: number;
  }): ThresholdChange {
    return this.transaction(() => {
      const mandate = this.requireMandate(input.mandate_id);
      const now = new Date().toISOString();
      const thresholdBefore = mandate.confidence_threshold;

      const updated = this.saveMandate({
        ...mandate,
        confidence_threshold: input.newThreshold,
        history: {
          ...mandate.history,
          undisputed_actions: mandate.history.undisputed_actions + 1,
          last_adjusted: now,
        },
        updated_at: now,
      });

      return {
        mandate: updated,
        threshold_before: thresholdBefore,
        threshold_after: updated.confidence_threshold,
      };
    });
  }

  listDisputes(mandateId?: string): DisputeRecord[] {
    const clause = mandateId !== undefined ? `WHERE mandate_id = ?` : "";
    const params = mandateId !== undefined ? [mandateId] : [];
    return this.db
      .prepare(`SELECT * FROM disputes ${clause} ORDER BY disputed_at DESC`)
      .all(...params) as unknown as DisputeRecord[];
  }

  /* ---------------------------------------------------------------------
   * Internals
   * ------------------------------------------------------------------ */

  private requireMandate(mandateId: string): Mandate {
    const mandate = this.getMandate(mandateId);
    if (!mandate) {
      throw new Error(`No mandate with id "${mandateId}"`);
    }
    return mandate;
  }

  /**
   * node:sqlite has no transaction wrapper of its own, so this is the
   * explicit BEGIN/COMMIT/ROLLBACK. Not re-entrant: SQLite rejects a nested
   * BEGIN, and nothing here nests.
   */
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
