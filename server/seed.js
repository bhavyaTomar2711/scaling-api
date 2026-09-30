import db, { isIndexEnabled } from "./db.js";

export function seedUsers(n = 10000) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (count >= n) return { seeded: false, count };

  const insert = db.prepare(
    "INSERT INTO users (id, name, email, payload) VALUES (?, ?, ?, ?)"
  );
  const txn = db.transaction((total) => {
    for (let i = count + 1; i <= total; i++) {
      insert.run(
        i,
        `user_${i}`,
        `${i}@example.com`,
        // Bulky payload makes each row read non-trivial (part of the "dumb" design)
        "x".repeat(256)
      );
    }
  });
  txn(n);
  return { seeded: true, count: n };
}

// (Statement reused across requests — the "dumb" part is the query itself,
// not re-compiling it)
const getUserStmt = db.prepare(
  "SELECT * FROM users WHERE LOWER(email) = LOWER(?)"
);

// Server-side DB query timing (avg over the rolling window, via metrics.js)
let queryTimeAccumulatorNs = 0n;
let queryCount = 0;

export function getAndResetQueryStats() {
  const avgMs = queryCount > 0 ? Number(queryTimeAccumulatorNs) / 1e6 / queryCount : 0;
  const qps = queryCount; // per second (getAndReset is called every 1s)
  queryTimeAccumulatorNs = 0n;
  queryCount = 0;
  return { avgQueryMs: Math.round(avgMs * 1000) / 1000, queriesPerSec: qps };
}

export function getUserById(id) {
  // Intentionally "dumb" query for Phase 1 baseline:
  // - SELECT * pulls the bulky payload column
  // - WHERE on a non-indexed lowercase comparison forces a full table scan
  // Phase 3: creating an expression index on LOWER(email) turns this exact
  // same query into an index seek — no code change needed, that's the point.
  const start = process.hrtime.bigint();
  const row = getUserStmt.get(`${id}@example.com`);
  queryTimeAccumulatorNs += process.hrtime.bigint() - start;
  queryCount++;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
  };
}

// Uncached lookup used as the cache-miss path (skips query timing dedup)
export function lookupUserRaw(id) {
  const row = getUserStmt.get(`${id}@example.com`);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
  };
}

// Query plan introspection — proves SCAN vs SEARCH to the dashboard
export function getQueryPlan() {
  const plan = db
    .prepare("EXPLAIN QUERY PLAN SELECT * FROM users WHERE LOWER(email) = LOWER(?)")
    .all("42@example.com");
  return {
    indexEnabled: isIndexEnabled(),
    usingIndex: plan.some((p) => (p.detail || "").includes("USING INDEX")),
    detail: plan.map((p) => p.detail).join(" | "),
  };
}
