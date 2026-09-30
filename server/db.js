import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "app.db"));

// Deliberately unoptimized for Phase 1:
// - No index on the lookup column we filter by (queries will full-scan)
// - A bulky payload column so each row read is non-trivial
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// NOTE: no index on email by default — GET /users/:id does a full table scan
// on purpose (Phase 3 adds the index and we compare before/after).

let indexEnabled = false;

// Phase 3: toggle the covering index for the LOWER(email) lookup.
// With expression index: index seek (~0.01ms). Without: full scan of 10k rows.
export function setIndexEnabled(enabled) {
  if (enabled === indexEnabled) return indexEnabled;
  if (enabled) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_users_lower_email ON users (LOWER(email))");
  } else {
    db.exec("DROP INDEX IF EXISTS idx_users_lower_email");
  }
  indexEnabled = enabled;
  return indexEnabled;
}

export function isIndexEnabled() {
  return indexEnabled;
}

export default db;
