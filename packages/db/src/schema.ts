/**
 * SQLite schema for mandates, vouches and disputes.
 *
 * STORAGE SHAPE: each row keeps the full Zod-validated object as JSON in a
 * `doc` column, plus a small number of real columns for the fields that are
 * actually filtered, sorted or joined on. The alternative — a column per
 * field — was rejected because Mandate.constraints is deliberately a
 * `.catchall()` open map (see packages/shared/src/mandate.ts), so a
 * fully-normalised schema would need a migration every time a new
 * category-specific constraint appears, which is exactly the flexibility
 * that field was given up for.
 *
 * The duplication between a `doc` and its extracted columns is a real cost:
 * they can drift. Every write in store.ts derives the columns from the
 * document in the same statement, and every read re-parses `doc` through the
 * Zod schema, so a drifted or hand-edited row fails loudly at the read
 * rather than silently serving a stale status.
 *
 * WHY node:sqlite AND NOT better-sqlite3: Node 24 ships DatabaseSync in core,
 * unflagged. better-sqlite3 is a native module needing a compile toolchain at
 * install time, which on a Windows/WSL checkout is a real source of "works on
 * my machine". This follows the same reasoning that picked `node --test` over
 * a test framework — the project is already on Node 24 for native type
 * stripping, so use what that buys.
 */

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mandates (
  mandate_id           TEXT PRIMARY KEY,
  status               TEXT NOT NULL,
  confidence_threshold REAL NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  doc                  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vouches (
  vouch_id       TEXT PRIMARY KEY,
  mandate_id     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  action_status  TEXT NOT NULL,
  within_bounds  INTEGER NOT NULL,
  doc            TEXT NOT NULL,
  FOREIGN KEY (mandate_id) REFERENCES mandates (mandate_id)
);

CREATE INDEX IF NOT EXISTS idx_vouches_mandate ON vouches (mandate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vouches_created ON vouches (created_at DESC);

/*
 * A dispute is also embedded on its Vouch (Vouch.dispute), because a Vouch is
 * the object handed to the Fire TV surface and it has to be readable on its
 * own. This table exists in addition so that "how has this mandate's
 * authority moved over time" is a query rather than a scan of every vouch
 * document. recordDispute() writes both inside one transaction.
 */
CREATE TABLE IF NOT EXISTS disputes (
  dispute_id                 TEXT PRIMARY KEY,
  vouch_id                   TEXT NOT NULL,
  mandate_id                 TEXT NOT NULL,
  disputed_at                TEXT NOT NULL,
  reason                     TEXT,
  confidence_threshold_delta REAL,
  threshold_before           REAL NOT NULL,
  threshold_after            REAL NOT NULL,
  FOREIGN KEY (vouch_id) REFERENCES vouches (vouch_id),
  FOREIGN KEY (mandate_id) REFERENCES mandates (mandate_id)
);

CREATE INDEX IF NOT EXISTS idx_disputes_mandate ON disputes (mandate_id, disputed_at DESC);
`;
