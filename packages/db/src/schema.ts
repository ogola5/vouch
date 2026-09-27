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

/*
 * The household model's memory (packages/household). Append-only events per
 * item — purchases, "we're out", "about half left" — because the forecast is
 * recomputed from the whole history every time rather than kept as a running
 * state that could drift from what actually happened. Days are whole numbers
 * on the household's clock (household_meta 'today'), which the demo can
 * advance; nothing here reads the wall clock.
 */
CREATE TABLE IF NOT EXISTS household_events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  TEXT NOT NULL,
  day      INTEGER NOT NULL,
  doc      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_household_events_item ON household_events (item_id, day);

/* Per-item settings the household chose: question mode, its own answer to "how often?". */
CREATE TABLE IF NOT EXISTS household_items (
  item_id  TEXT PRIMARY KEY,
  doc      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS household_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

/*
 * The household's passkeys (WebAuthn). Only the PUBLIC key is ever stored —
 * the private key never leaves the household's device. sign_count is kept so
 * a cloned authenticator replaying an old counter is refused.
 */
/*
 * The tamper-evident record (BUILD_PLAN.md §3b, W3b). A Vouch changes
 * legitimately — held becomes approved, a dispute is added — so the chain is
 * not over the Vouch itself but over an APPEND-ONLY history of it: every
 * write of a Vouch appends a snapshot, hashed together with the previous
 * entry's hash. Editing any entry breaks every link after it; editing the
 * vouches table the console reads no longer matches its latest snapshot.
 */
CREATE TABLE IF NOT EXISTS ledger (
  seq        INTEGER PRIMARY KEY,
  vouch_id   TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL,
  doc        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_vouch ON ledger (vouch_id, seq);

/*
 * Study sessions (BUILD_PLAN.md §3b W5c/W7): what real people answered while
 * trying the product. A code, never a name; kept on this computer only.
 */
CREATE TABLE IF NOT EXISTS study_responses (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  doc         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id  TEXT PRIMARY KEY,
  doc            TEXT NOT NULL
);
`;
