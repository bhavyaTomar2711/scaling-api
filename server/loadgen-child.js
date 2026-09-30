// Standalone load generator worker (like a Locust worker process).
// Usage: node loadgen-child.js <targetRps> <port> <statsPort> <childId>
//
// Uses a small pool of raw keep-alive sockets with STRICT pipeline depth
// (like wrk) — Node's http.Agent serializes one request per socket, which
// collapses on Windows loopback. Latency is measured CLIENT-SIDE (queueing
// delay included), and stats POST to the API every second.

import net from "node:net";
import http from "node:http";

const targetRps = Number(process.argv[2] || 500);
const port = Number(process.argv[3] || 4000);
const statsPort = Number(process.argv[4] || port);
const childId = Number(process.argv[5] || 0);
const host = "127.0.0.1";

const SOCKETS = 8;
const DEPTH = 16; // max in-flight requests per socket (strict bound)
const MAX_INFLIGHT = SOCKETS * DEPTH * 4; // client-side queue bound

let running = true;
let tokens = 0;

// ---- Stats (1s window, reset after each POST) ----
let sent = 0, completed = 0, failed = 0, retries = 0;
let windowSent = 0, windowCompleted = 0, windowFailed = 0;
let windowLatencies = [];
let inFlight = 0; // includes client-side queued requests

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// ---- Pre-rendered request templates ----
const TEMPLATES = 64;
const templates = [];
for (let i = 0; i < TEMPLATES; i++) {
  templates.push(
    `GET /users/${1 + Math.floor(Math.random() * 10000)} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`
  );
}

// ---- Socket pool ----
const sockets = [];

function connectSocket(i, attempt = 0) {
  const sock = net.connect(port, host, () => {
    sock._ready = true;
  });
  sock.setNoDelay(true);
  sock._buffer = "";
  sock._pending = []; // FIFO timestamps of written requests
  sock._outbuf = []; // written-but-not-flushed backlog entries

  sock.on("data", (d) => {
    sock._buffer += d.toString("latin1");
    for (;;) {
      const headerEnd = sock._buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const headers = sock._buffer.slice(0, headerEnd);
      const clMatch = headers.match(/content-length: (\d+)/i);
      const contentLength = clMatch ? Number(clMatch[1]) : 0;
      const totalLen = headerEnd + 4 + contentLength;
      if (sock._buffer.length < totalLen) break;
      sock._buffer = sock._buffer.slice(totalLen);

      const startTs = sock._pending.shift();
      inFlight = Math.max(0, inFlight - 1);
      const ms = startTs ? Number(process.hrtime.bigint() - startTs) / 1e6 : 0;
      if (headers.includes(" 200 ")) {
        windowCompleted++;
        completed++;
        windowLatencies.push(ms);
      } else {
        windowFailed++;
        failed++;
      }
    }
    flushOutbuf(sock);
  });

  sock.on("error", (e) => {
    if (e.code === "ECONNREFUSED" && attempt < 30) {
      retries++;
      sock.destroy();
      setTimeout(() => connectSocket(i, attempt + 1), 100);
    } else {
      const lost = sock._pending.length;
      failed += lost;
      windowFailed += lost;
      inFlight = Math.max(0, inFlight - lost);
      sock.destroy();
      sockets[i] = null;
      if (running) setTimeout(() => connectSocket(i), 250);
    }
  });

  sock.on("close", () => {
    sock._ready = false;
  });

  sockets[i] = sock;
}

function flushOutbuf(sock) {
  while (sock._outbuf.length > 0 && !sock.writableNeedDrain) {
    const item = sock._outbuf.shift();
    sock.write(item.data);
    sock._pending.push(item.ts);
  }
}

// ---- Token-bucket pump: strictly bounded by DEPTH per socket ----
function pump() {
  if (!running) return;
  if (tokens >= 1 && inFlight < MAX_INFLIGHT) {
    for (const sock of sockets) {
      if (!sock || !sock._ready || sock.destroyed) continue;
      const outstanding = sock._outbuf.length + sock._pending.length;
      let budget = DEPTH - outstanding;
      while (budget > 0 && tokens >= 1) {
        const template = templates[(Math.random() * TEMPLATES) | 0];
        sock._outbuf.push({ data: template, ts: process.hrtime.bigint() });
        inFlight++;
        sent++;
        windowSent++;
        budget--;
        tokens--;
      }
      if (sock._outbuf.length > 0) flushOutbuf(sock);
      if (tokens < 1 || inFlight >= MAX_INFLIGHT) break;
    }
  }
  setTimeout(pump, 2); // low-frequency pump: bounded work per tick
}

const refill = setInterval(() => {
  tokens = Math.min(tokens + targetRps / 20, targetRps);
}, 50);

for (let i = 0; i < SOCKETS; i++) connectSocket(i);
pump();

// ---- Stats POST every second ----
setInterval(() => {
  if (!running) return;
  const payload = JSON.stringify({
    childId,
    targetRps,
    sentRps: windowSent,
    achievedRps: windowCompleted,
    failedRps: windowFailed,
    avgLatency:
      windowLatencies.length > 0
        ? windowLatencies.reduce((a, b) => a + b, 0) / windowLatencies.length
        : 0,
    p50Latency: percentile(windowLatencies, 50),
    p99Latency: percentile(windowLatencies, 99),
    errorRate: windowSent > 0 ? (windowFailed / windowSent) * 100 : 0,
    inFlight,
    totalSent: sent,
    totalCompleted: completed,
    totalFailed: failed,
    retries,
  });
  windowSent = 0;
  windowCompleted = 0;
  windowFailed = 0;
  windowLatencies = [];
  const post = http.request(
    {
      host,
      port: statsPort,
      path: "/loadgen/stats",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    (res) => res.resume()
  );
  post.on("error", () => {});
  post.end(payload);
}, 1000);

process.on("SIGTERM", () => {
  running = false;
  clearInterval(refill);
  for (const s of sockets) s?.destroy();
  process.exit(0);
});
