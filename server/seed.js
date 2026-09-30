import db from "./db.js";

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

export function getUserById(id) {
  // Intentionally "dumb" query for Phase 1:
  // - SELECT * pulls the bulky payload column
  // - WHERE on a non-indexed lowercase comparison forces a full table scan
  const row = getUserStmt.get(`${id}@example.com`);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
  };
}
