import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import http from "node:http";

// Phase 7: Load balancing across CPU cores.
//
// The balancer runs on its OWN port (4050) — the main API server on :4000 is
// NEVER stopped, so SSE, metrics, and toggle endpoints stay alive at all
// times. When a load test starts with the cluster ON, requests go through
// :4050 → round-robin to workers. Stats still flow back to :4000.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKERS = Math.max(2, Math.min(4, os.cpus().length - 1));
const BASE_PORT = 4100;
export const BALANCER_PORT = 4050;

export const clusterState = {
  enabled: false,
  workers: 0,
  ports: [],
  nextWorker: 0,
};

let workers = [];
let balancerServer = null;

function spawnWorker(port) {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "index.js")],
    {
      env: { ...process.env, API_PORT: String(port), WORKER_MODE: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  child.stderr?.on("data", (d) => {
    const s = d.toString();
    if (!s.includes("API on") && !s.includes("DB already") && !s.includes("Seeded")) {
      console.error(`[worker-${port}]`, s.trim());
    }
  });
  return child;
}

function waitPortReady(port, retries = 50) {
  return new Promise((resolve) => {
    const tryConnect = (n) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        sock.destroy();
        if (n <= 0) return resolve(false);
        setTimeout(() => tryConnect(n - 1), 100);
      });
    };
    tryConnect(retries);
  });
}

let toggleInFlight = false;

export async function broadcastToWorkers(urlPath) {
  if (!clusterState.enabled || clusterState.ports.length === 0) return;
  const promises = clusterState.ports.map((port) =>
    fetch(`http://127.0.0.1:${port}${urlPath}`, { method: "POST" }).catch(() => {})
  );
  await Promise.all(promises);
}

export async function enableCluster() {
  if (toggleInFlight) return clusterState;
  toggleInFlight = true;
  try {
    await cleanupWorkers();
    if (clusterState.enabled) return clusterState;

    // Spawn workers on their own ports
    for (let i = 0; i < WORKERS; i++) {
      const port = BASE_PORT + i;
      workers.push({ port, child: spawnWorker(port) });
      clusterState.ports.push(port);
    }
    for (const w of workers) {
      const up = await waitPortReady(w.port);
      if (!up) console.error(`[cluster] worker on :${w.port} failed to start`);
    }

    // Sync toggle states to worker processes
    try {
      const { cacheState } = await import("./cache.js");
      const { poolState } = await import("./pool.js");
      const { isIndexEnabled } = await import("./db.js");
      for (const w of workers) {
        if (cacheState.enabled) fetch(`http://127.0.0.1:${w.port}/cache/on`, { method: "POST" }).catch(() => {});
        if (poolState.enabled) fetch(`http://127.0.0.1:${w.port}/pool/on`, { method: "POST" }).catch(() => {});
        if (isIndexEnabled()) fetch(`http://127.0.0.1:${w.port}/index/on`, { method: "POST" }).catch(() => {});
      }
    } catch (e) {
      console.error("[cluster] sync state to workers failed:", e);
    }

    // Start the balancer on its OWN port — main server stays untouched
    balancerServer = net.createServer((client) => {
      if (workers.length === 0) { client.destroy(); return; }
      const w = workers[clusterState.nextWorker % workers.length];
      if (!w) { client.destroy(); return; }
      clusterState.nextWorker++;
      const upstream = net.connect(w.port, "127.0.0.1");
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });

    await new Promise((resolve, reject) => {
      balancerServer.once("error", reject);
      balancerServer.listen(BALANCER_PORT, "127.0.0.1", () => {
        balancerServer.removeListener("error", reject);
        resolve();
      });
    });

    clusterState.enabled = true;
    clusterState.workers = workers.length;
    console.log(`[cluster] ON — ${workers.length} workers on ports ${clusterState.ports.join(", ")}, balancer on :${BALANCER_PORT}`);
    return clusterState;
  } catch (err) {
    // Rollback on failure
    console.error("[cluster] enable failed:", err.message);
    if (balancerServer) {
      try { balancerServer.close(); } catch { /* ignore */ }
      balancerServer = null;
    }
    await cleanupWorkers();
    return clusterState;
  } finally {
    toggleInFlight = false;
  }
}

export async function disableCluster() {
  if (toggleInFlight) return clusterState;
  toggleInFlight = true;
  try {
    if (!clusterState.enabled) return clusterState;
    clusterState.enabled = false;

    if (balancerServer) {
      await new Promise((r) => balancerServer.close(r));
      balancerServer = null;
    }
    await cleanupWorkers();

    console.log("[cluster] OFF — balancer stopped");
    return clusterState;
  } finally {
    toggleInFlight = false;
  }
}

async function cleanupWorkers() {
  if (workers.length > 0) {
    for (const w of workers) {
      try { w.child.kill("SIGTERM"); } catch { /* already dead */ }
    }
    await new Promise((r) => setTimeout(r, 500));
    for (const w of workers) {
      try { if (w.child.exitCode === null) w.child.kill("SIGKILL"); } catch { /* */ }
    }
    workers = [];
  }
  clusterState.ports = [];
  clusterState.workers = 0;

  const ports = Array.from({ length: WORKERS }, (_, i) => BASE_PORT + i);
  for (let attempt = 0; attempt < 50; attempt++) {
    const busy = [];
    for (const p of ports) {
      if (await waitPortReady(p, 1)) busy.push(p);
    }
    if (busy.length === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---- Control channel (port 4199) ----
export const CONTROL_PORT = 4199;

export function startControlServer() {
  const control = http.createServer((req, res) => {
    const reply = (obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    };
    if (req.method === "POST" && /^\/cluster\/(on|off)$/.test(req.url || "")) {
      const state = req.url.endsWith("/on");
      reply({ ok: true, ...(state ? { pending: true } : getClusterStats()) });
      setImmediate(async () => {
        try {
          if (state) await enableCluster();
          else await disableCluster();
        } catch (err) {
          console.error("[cluster] toggle failed:", err);
        }
      });
    } else if (req.method === "GET" && req.url === "/cluster/stats") {
      reply(getClusterStats());
    } else {
      reply({ ok: false, error: "unknown control route" });
    }
  });
  control.on("error", (err) => console.error("[cluster] control server error:", err.message));
  control.listen(CONTROL_PORT, "127.0.0.1", () => {
    console.log(`[cluster] control channel on :${CONTROL_PORT}`);
  });
  return control;
}

export function getClusterStats() {
  return {
    enabled: clusterState.enabled,
    workers: clusterState.workers,
    ports: [...clusterState.ports],
    balancerPort: BALANCER_PORT,
    maxWorkers: WORKERS,
  };
}
