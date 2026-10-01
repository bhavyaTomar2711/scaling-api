import { lookupUserRaw } from "./seed.js";

// Phase 5: Connection pooling.
//
// Models a network DB (like PostgreSQL) where every connection is a scarce
// resource with real overhead. Two modes:
//
//   POOL OFF ("new connection per request" — the wasteful default):
//     every request pays full connection setup (TCP/auth/handshake) + teardown.
//     Under high concurrency, connections pile up and each setup gets slower.
//
//   POOL ON (max 20 connections):
//     connections are reused; excess requests WAIT in a queue for a free
//     connection. Wait time is tracked — it stays tiny compared to setup cost.

const POOL_SIZE = 20;
const FAKE_CONN_SETUP_MS = 2.5; // per-connection TCP/auth/handshake cost
const FAKE_CONN_TEARDOWN_MS = 1;
// (Simulates a network DB like PostgreSQL; SQLite itself is in-process.)

export const poolState = {
  enabled: false, // the FIX switch
  // live pool metrics
  active: 0,
  queued: 0,
  totalCreated: 0,
  totalAcquired: 0, // pool-mode: requests served from the pool
  totalWaitMs: 0,
  waits: [], // recent wait times for percentile calc
  connTimeMs: 0, // total time spent creating/destroying connections
};

function resetConnStats() {
  poolState.totalCreated = 0;
  poolState.totalWaitMs = 0;
  poolState.waits = [];
  poolState.connTimeMs = 0;
}

export function setPoolEnabled(enabled) {
  poolState.enabled = enabled;
  resetConnStats();
  return poolState.enabled;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- POOL OFF path: new connection per request ----
export async function queryWithNewConnection(id) {
  const start = performance.now();
  poolState.totalCreated++;
  // connection setup: gets slower when many connections are being made at once
  // (port exhaustion / DB auth bottleneck — the production failure mode)
  const concurrentPenalty = 1 + poolState.active * 0.15;
  await sleep(FAKE_CONN_SETUP_MS * concurrentPenalty);
  const row = lookupUserRaw(id); // the actual query
  await sleep(FAKE_CONN_TEARDOWN_MS);
  poolState.connTimeMs += performance.now() - start;
  return row;
}

// ---- POOL ON path: acquire from a bounded pool, wait if exhausted ----
let freeConnections = POOL_SIZE;
const waiters = [];

async function acquire() {
  if (freeConnections > 0) {
    freeConnections--;
    poolState.active++;
    return;
  }
  // queue for a free connection — THIS is the wait time we track
  poolState.queued++;
  const start = performance.now();
  await new Promise((resolve) => waiters.push(resolve));
  poolState.queued = Math.max(0, poolState.queued - 1);
  const waited = performance.now() - start;
  poolState.totalWaitMs += waited;
  poolState.waits.push(waited);
  if (poolState.waits.length > 2000) poolState.waits.shift();
  poolState.active++;
}

function release() {
  poolState.active--;
  const next = waiters.shift();
  if (next) next(); // hand the connection to the next waiter (no re-setup cost)
  else freeConnections = Math.min(POOL_SIZE, freeConnections + 1);
}

export async function queryWithPool(id) {
  await acquire();
  poolState.totalAcquired++;
  try {
    return lookupUserRaw(id); // connection already established — just query
  } finally {
    release();
  }
}

export async function queryUser(id) {
  if (poolState.enabled) return queryWithPool(id);
  return queryWithNewConnection(id);
}

export function getPoolStats() {
  const waits = [...poolState.waits].sort((a, b) => a - b);
  const avgWait =
    poolState.waits.length > 0
      ? poolState.waits.reduce((a, b) => a + b, 0) / poolState.waits.length
      : 0;
  return {
    enabled: poolState.enabled,
    poolSize: POOL_SIZE,
    active: poolState.active,
    queued: poolState.queued,
    totalConnectionsCreated: poolState.totalCreated,
    totalAcquired: poolState.totalAcquired,
    avgWaitMs: Math.round(avgWait * 100) / 100,
    p99WaitMs: waits.length
      ? Math.round(waits[Math.min(waits.length - 1, Math.floor(waits.length * 0.99))] * 100) / 100
      : 0,
    connOverheadMs: Math.round(poolState.connTimeMs),
  };
}
