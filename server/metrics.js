import os from "node:os";

// Rolling window of completed requests for rate/latency calculations
const WINDOW_MS = 5000;
let samples = []; // { t, latency, error }

// Process CPU sampling: compare cpu usage deltas
let lastCpu = process.cpuUsage();
let lastCpuTime = process.hrtime.bigint();

let activeConnections = 0;
let totalRequests = 0;
let totalErrors = 0;

export function recordRequest(latencyMs, isError) {
  const t = Date.now();
  samples.push({ t, latency: latencyMs, error: isError });
  totalRequests++;
  if (isError) totalErrors++;
}

// Clear the rolling window (used between benchmark levels for clean readings)
export function resetWindowMetrics() {
  samples = [];
}

export function incConnections() {
  activeConnections++;
}
export function decConnections() {
  activeConnections = Math.max(0, activeConnections - 1);
}

function cpuPercent() {
  const nowCpu = process.cpuUsage();
  const nowTime = process.hrtime.bigint();
  const elapsedMs = Number(nowTime - lastCpuTime) / 1e6;
  if (elapsedMs <= 0) return 0;
  const usedMs = (nowCpu.user - lastCpu.user + (nowCpu.system - lastCpu.system)) / 1000;
  lastCpu = nowCpu;
  lastCpuTime = nowTime;
  // Normalized against one core (single-node process)
  return Math.min(100, (usedMs / elapsedMs) * 100);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function getMetrics() {
  const now = Date.now();
  samples = samples.filter((s) => now - s.t <= WINDOW_MS);

  const latencies = samples.map((s) => s.latency).sort((a, b) => a - b);
  const avgLatency =
    latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;
  const p50 = percentile(latencies, 50);
  const p99 = percentile(latencies, 99);
  const windowSec = WINDOW_MS / 1000;
  const requestsPerSec = samples.length / windowSec;
  const errors = samples.filter((s) => s.error).length;
  const errorRate = samples.length > 0 ? (errors / samples.length) * 100 : 0;

  const mem = process.memoryUsage();

  return {
    timestamp: new Date().toISOString(),
    requestsPerSec: Math.round(requestsPerSec),
    avgLatency: Math.round(avgLatency * 10) / 10,
    p50Latency: Math.round(p50 * 10) / 10,
    p99Latency: Math.round(p99 * 10) / 10,
    errorRate: Math.round(errorRate * 100) / 100,
    cpuUsage: Math.round(cpuPercent() * 10) / 10,
    memoryUsage: Math.round(mem.heapUsed / 1024 / 1024),
    rssMemory: Math.round(mem.rss / 1024 / 1024),
    activeConnections,
    totalRequests,
    totalErrors,
    dbQueriesPerSec: 0, // placeholder, filled by server when tracking DB
  };
}

export function statusFor(m) {
  if (m.errorRate > 5 || m.avgLatency > 1000) return "critical";
  if (m.errorRate > 1 || m.avgLatency > 200) return "degrading";
  return "healthy";
}
