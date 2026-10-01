import express from "express";
import http from "node:http";
import db, { setIndexEnabled, isIndexEnabled } from "./db.js";
import {
  seedUsers,
  getQueryPlan,
  getAndResetQueryStats,
} from "./seed.js";
import {
  getUserCached,
  setCacheEnabled,
  getCacheInfo,
  flushCache,
} from "./cache.js";
import {
  recordRequest,
  incConnections,
  decConnections,
  getMetrics,
  statusFor,
} from "./metrics.js";
import { startLoad, stopLoad, isRunning, getLoadStats, recordChildStats } from "./loadgen.js";
import {
  queryUser,
  setPoolEnabled,
  getPoolStats,
} from "./pool.js";
import {
  clusterState,
  BALANCER_PORT,
  getClusterStats,
  startControlServer,
  broadcastToWorkers,
} from "./cluster.js";

const PORT = process.env.API_PORT || 4000;

// Seed on boot (100k rows — makes the full-scan vs index difference dramatic)
const seedInfo = seedUsers(100000);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" })); // needed for /loadgen/stats POST

// Metrics middleware: response time, request count, errors
app.use((req, res, next) => {
  if (req.path === "/events" || req.path === "/loadgen/stats") return next();
  const start = process.hrtime.bigint();
  incConnections();
  res.on("finish", () => {
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    recordRequest(latencyMs, res.statusCode >= 400);
    decConnections();
  });
  next();
});

// Core API endpoint — the one we hammer.
// Phase 4: goes through the cache layer (when cache is ON, DB is hit only
// on misses — a 5-min TTL means ~98%+ hit rate under sustained load).
app.get("/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  // Phase 4 cache → Phase 5 pooled connection on the miss path
  const { user, cacheHit } = await getUserCached(id, () => queryUser(id));
  if (!user) return res.status(404).json({ error: "user not found" });
  res.set("X-Cache", cacheHit ? "HIT" : "MISS");
  res.json(user);
});

// Metrics snapshot endpoint
app.get("/metrics", (req, res) => {
  res.json({ ...getMetrics(), status: statusFor(getMetrics()) });
});

// ---- Phase 4: Redis caching ----

app.post("/cache/:state", async (req, res) => {
  const state = req.params.state === "on";
  cacheStateEnabled = state;
  setCacheEnabled(state);
  if (!process.env.WORKER_MODE) {
    broadcastToWorkers(`/cache/${req.params.state}`);
  }
  res.json({ ok: true, ...(await getCacheInfo()) });
});

app.get("/cache/info", async (req, res) => {
  res.json(await getCacheInfo());
});

app.post("/cache/flush", async (req, res) => {
  await flushCache();
  res.json({ ok: true, ...(await getCacheInfo()) });
});

// ---- Phase 5: Connection pooling ----

app.post("/pool/:state", (req, res) => {
  const state = req.params.state === "on";
  setPoolEnabled(state);
  if (!process.env.WORKER_MODE) {
    broadcastToWorkers(`/pool/${req.params.state}`);
  }
  res.json({ ok: true, ...getPoolStats() });
});

app.get("/pool/stats", (req, res) => {
  res.json(getPoolStats());
});

let cacheStateEnabled = false;
let cacheHitsSnapshot = 0;
let cacheMissesSnapshot = 0;

// Refresh cache snapshot every second for the SSE broadcast
setInterval(async () => {
  const info = await getCacheInfo();
  cacheHitsSnapshot = info.hits;
  cacheMissesSnapshot = info.misses;
}, 1000);

// Toggle the index on/off (the FIX switch)
app.post("/index/:state", (req, res) => {
  const state = req.params.state === "on";
  setIndexEnabled(state);
  if (!process.env.WORKER_MODE) {
    broadcastToWorkers(`/index/${req.params.state}`);
  }
  res.json({ ok: true, indexEnabled: isIndexEnabled(), ...getQueryPlan() });
});

// ---- Phase 7: Load balancing (scale across CPU cores) ----
// Cluster control on dedicated port (4199), main process only.
if (!process.env.WORKER_MODE) {
  startControlServer();
}

// Query plan proof: full scan vs index seek
app.get("/index/plan", (req, res) => {
  res.json(getQueryPlan());
});



// ---- Load generator control ----
app.post("/load/start", (req, res) => {
  const { targetRps = 5000 } = req.body || {};
  // When cluster is ON, hammer the balancer port (4050 → workers);
  // stats always flow back to the main server (PORT) for the dashboard.
  const loadPort = clusterState.enabled ? BALANCER_PORT : PORT;
  const ok = startLoad(Number(targetRps), loadPort, Number(PORT));
  res.json({ ok, running: isRunning(), targetRps });
});

app.post("/load/stop", (req, res) => {
  const ok = stopLoad();
  res.json({ ok, running: isRunning() });
});

app.get("/load/status", (req, res) => {
  res.json(getLoadStats());
});

// Load generator child reports client-side stats here every second
app.post("/loadgen/stats", (req, res) => {
  recordChildStats(req.body);
  res.json({ ok: true });
});

// ---- SSE: real-time metrics broadcast every 500ms ----
let sseClients = [];
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 1000\n\n");
  sseClients.push(res);
  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

setInterval(() => {
  const m = getMetrics();
  const loadStats = getLoadStats();
  const isLoadActive = loadStats.running || loadStats.achievedRps > 0;

  const rps = isLoadActive ? (loadStats.achievedRps ?? 0) : m.requestsPerSec;
  const avgLat = isLoadActive ? Math.round((loadStats.avgLatency ?? 0) * 10) / 10 : m.avgLatency;
  const p50Lat = isLoadActive ? Math.round((loadStats.p50Latency ?? 0) * 10) / 10 : m.p50Latency;
  const p99Lat = isLoadActive ? Math.round((loadStats.p99Latency ?? 0) * 10) / 10 : m.p99Latency;
  const errRate = isLoadActive ? Math.round((loadStats.errorRate ?? 0) * 10) / 10 : m.errorRate;
  const activeConn = isLoadActive ? (loadStats.inFlight ?? 0) : m.activeConnections;

  const combinedMetrics = {
    ...m,
    requestsPerSec: rps,
    avgLatency: avgLat,
    p50Latency: p50Lat,
    p99Latency: p99Lat,
    errorRate: errRate,
    activeConnections: activeConn,
  };

  const payload = JSON.stringify({
    ...combinedMetrics,
    status: statusFor(combinedMetrics),
    load: loadStats,
    // Client-observed metrics (what Locust would show) take precedence
    client: {
      achievedRps: loadStats.achievedRps ?? 0,
      avgLatency: loadStats.avgLatency ?? 0,
      p50Latency: loadStats.p50Latency ?? 0,
      p99Latency: loadStats.p99Latency ?? 0,
      errorRate: loadStats.errorRate ?? 0,
      inFlight: loadStats.inFlight ?? 0,
    },
    // Phase 3: DB query performance + plan proof
    db: { ...getAndResetQueryStats(), ...getQueryPlan() },
    // Phase 4: cache stats (hit rate, driver) — snapshot w/o blocking SSE
    cache: {
      enabled: cacheStateEnabled,
      hits: cacheHitsSnapshot,
      misses: cacheMissesSnapshot,
    },
    // Phase 5: connection pool stats
    pool: getPoolStats(),
    // Phase 7: cluster stats
    cluster: getClusterStats(),
  });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}, 500);

const server = http.createServer(app);
server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;
// Bind IPv4 explicitly — workers and the balancer talk over 127.0.0.1, and
// binding :: (all interfaces) invites EADDRINUSE from stale listeners.
const HOST = "127.0.0.1";
server.on("connection", (socket) => socket.setNoDelay(true)); // loopback latency fix

// (Port 4000 is never stopped — cluster balancer uses port 4050 separately)

// Main process on :4000, workers on :4100+. Port 4000 is NEVER stopped.
server.listen(PORT, HOST, () => {
  if (process.env.WORKER_MODE) {
    console.log(`API worker on http://127.0.0.1:${PORT}`);
  } else {
    console.log(`API on http://localhost:${PORT}`);
    console.log(
      seedInfo.seeded
        ? `Seeded ${seedInfo.count} users.`
        : `DB already has ${seedInfo.count} users (skipped seeding).`
    );
  }
});

// If we can't bind our port on startup, exit cleanly.
server.on("error", (err) => {
  console.error(`[api :${PORT}] server error:`, err.message);
  process.exit(1);
});
