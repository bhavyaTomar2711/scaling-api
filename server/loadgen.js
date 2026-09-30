import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Manages N load generator worker processes (Locust-style master + workers),
// so their event loops never compete with the API server's.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKERS = 2;

let workers = []; // active child processes
let currentTarget = 0;
let startedAt = 0;
let workerStats = new Map(); // childId -> latest stats

export function isRunning() {
  return workers.length > 0;
}
export function getTarget() {
  return currentTarget;
}

export function recordChildStats(stats) {
  if (!stats || typeof stats !== "object") return;
  workerStats.set(stats.childId, { ...stats, receivedAt: Date.now() });
  // prune stale entries
  const now = Date.now();
  for (const [k, v] of workerStats) {
    if (now - v.receivedAt > 5000) workerStats.delete(k);
  }
}

export function getLoadStats() {
  const uptimeSec = startedAt > 0 ? (Date.now() - startedAt) / 1000 : 0;
  const agg = {
    achievedRps: 0,
    failedRps: 0,
    sentRps: 0,
    inFlight: 0,
    retries: 0,
    errorRate: 0,
    avgLatency: 0,
    p50Latency: 0,
    p99Latency: 0,
    workers: 0,
  };
  const latencies = [];
  for (const s of workerStats.values()) {
    agg.achievedRps += s.achievedRps || 0;
    agg.failedRps += s.failedRps || 0;
    agg.inFlight += s.inFlight || 0;
    agg.retries += s.retries || 0;
    agg.workers++;
    if (s.avgLatency > 0) latencies.push(s.avgLatency, s.p50Latency || s.avgLatency);
    if (s.p99Latency > agg.p99Latency) agg.p99Latency = s.p99Latency;
  }
  agg.sentRps = agg.achievedRps + agg.failedRps;
  agg.errorRate =
    agg.sentRps > 0 ? (agg.failedRps / agg.sentRps) * 100 : 0;
  if (latencies.length > 0) {
    agg.avgLatency =
      latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const sorted = [...latencies].sort((a, b) => a - b);
    agg.p50Latency = sorted[Math.floor(sorted.length / 2)];
  }
  return {
    running: isRunning(),
    target: currentTarget,
    uptimeSec: Math.round(uptimeSec),
    ...agg,
  };
}

export function startLoad(targetRps, port) {
  if (isRunning()) return false;
  currentTarget = targetRps;
  startedAt = Date.now();
  workerStats.clear();

  const perWorker = Math.max(50, Math.round(targetRps / WORKERS));
  workers = [];
  for (let i = 0; i < WORKERS; i++) {
    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, "loadgen-child.js"),
        String(perWorker),
        String(port),
        String(port),
        String(i),
      ],
      { stdio: ["ignore", "ignore", "pipe"], detached: false }
    );
    child.stderr?.on("data", (d) => console.error(`[loadgen-${i}] ${d}`));
    child.on("exit", () => {
      workers = workers.filter((w) => w !== child);
    });
    workers.push(child);
  }
  return true;
}

export function stopLoad() {
  if (!isRunning()) return false;
  for (const w of workers) w.kill("SIGTERM");
  workers = [];
  currentTarget = 0;
  startedAt = 0;
  workerStats.clear();
  return true;
}
