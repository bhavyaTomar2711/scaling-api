import express from "express";
import http from "node:http";
import os from "node:os";
import db from "./db.js";
import { seedUsers, getUserById } from "./seed.js";
import {
  recordRequest,
  incConnections,
  decConnections,
  getMetrics,
  statusFor,
} from "./metrics.js";
import { startLoad, stopLoad, isRunning, getLoadStats, recordChildStats } from "./loadgen.js";

const PORT = process.env.API_PORT || 4000;

// Seed on boot (10k rows — big enough to be realistic, fast to load)
const seedInfo = seedUsers(10000);

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

// Core API endpoint — the one we hammer
app.get("/users/:id", (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: "user not found" });
  res.json(user);
});

// Metrics snapshot endpoint
app.get("/metrics", (req, res) => {
  res.json({ ...getMetrics(), status: statusFor(getMetrics()) });
});

// ---- Load generator control ----
app.post("/load/start", (req, res) => {
  const { targetRps = 5000 } = req.body || {};
  const ok = startLoad(Number(targetRps), PORT);
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
  const payload = JSON.stringify({
    ...m,
    status: statusFor(m),
    load: getLoadStats(),
    // Client-observed metrics (what Locust would show) take precedence
    client: {
      achievedRps: getLoadStats().achievedRps ?? 0,
      avgLatency: getLoadStats().avgLatency ?? 0,
      p50Latency: getLoadStats().p50Latency ?? 0,
      p99Latency: getLoadStats().p99Latency ?? 0,
      errorRate: getLoadStats().errorRate ?? 0,
      inFlight: getLoadStats().inFlight ?? 0,
    },
  });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}, 500);

const server = http.createServer(app);
server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;
server.on("connection", (socket) => socket.setNoDelay(true)); // loopback latency fix

server.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`);
  console.log(
    seedInfo.seeded
      ? `Seeded ${seedInfo.count} users.`
      : `DB already has ${seedInfo.count} users (skipped seeding).`
  );
});
