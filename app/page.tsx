"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

type Metrics = {
  timestamp: string;
  requestsPerSec: number;
  avgLatency: number;
  p50Latency: number;
  p99Latency: number;
  errorRate: number;
  cpuUsage: number;
  memoryUsage: number;
  activeConnections: number;
  totalRequests: number;
  totalErrors: number;
  status: "healthy" | "degrading" | "critical";
  load: { running: boolean; target: number };
  db: {
    avgQueryMs: number;
    queriesPerSec: number;
    indexEnabled: boolean;
    usingIndex: boolean;
    detail: string;
  };
  cache: { enabled: boolean; hits: number; misses: number };
  pool: { enabled: boolean; active: number; queued: number; avgWaitMs: number };
  cluster: { enabled: boolean; workers: number; maxWorkers: number };
};

type Point = {
  t: number;
  rps: number;
  latency: number;
  p99: number;
  errors: number;
  cpu: number;
};

const LOAD_LEVELS = [1000, 2000, 3000];

function fmt(n: number) {
  return n.toLocaleString();
}

/* ---------------- Sliding toggle ---------------- */
function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-300 focus:outline-none ${
        checked ? "bg-emerald-600" : "bg-zinc-700"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-300 ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

/* ---------------- Fix card: name + toggle + one-liner ---------------- */
function FixCard({
  name,
  oneLinerOn,
  oneLinerOff,
  on,
  onToggle,
}: {
  name: string;
  oneLinerOn: string;
  oneLinerOff: string;
  on: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        on
          ? "border-emerald-500/20 bg-emerald-500/[0.03]"
          : "border-zinc-800/70 bg-[#111113]"
      }`}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span
            className={`h-1.5 w-1.5 rounded-full transition-colors ${
              on ? "bg-emerald-400" : "bg-zinc-600"
            }`}
          />
          <h3 className="text-sm font-medium text-zinc-100">{name}</h3>
        </div>
        <Toggle checked={on} onChange={onToggle} />
      </div>
      <p
        className={`mt-2.5 font-mono text-xs transition-colors ${
          on ? "text-emerald-300" : "text-zinc-400"
        }`}
      >
        {on ? oneLinerOn : oneLinerOff}
      </p>
    </div>
  );
}

const chartTooltip = {
  contentStyle: {
    background: "#131316",
    border: "1px solid #26262a",
    borderRadius: "8px",
    fontSize: "12px",
  },
  labelStyle: { color: "#71717a" },
  cursor: { stroke: "#3f3f46", strokeDasharray: "3 3" },
};

const panel =
  "rounded-xl border border-zinc-800/70 bg-[#111113]";

export default function Home() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [target, setTarget] = useState(1000);
  const [custom, setCustom] = useState("");
  const [connected, setConnected] = useState(false);
  const pointsRef = useRef<Point[]>([]);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;

    function connect() {
      if (unmounted) return;
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        // EventSource.CLOSED === 2: the browser gave up (non-200 response).
        // Auto-reconnect won't happen, so we recreate after a short delay.
        if (es?.readyState === EventSource.CLOSED && !unmounted) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
      es.onmessage = (e) => {
        const m: Metrics = JSON.parse(e.data);
        setMetrics(m);
        const p: Point = {
          t: Date.now(),
          rps: m.requestsPerSec,
          latency: m.avgLatency,
          p99: m.p99Latency,
          errors: m.errorRate,
          cpu: m.cpuUsage,
        };
        pointsRef.current = [...pointsRef.current.slice(-119), p];
        setPoints(pointsRef.current);
      };
    }

    connect();
    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  const startLoad = useCallback(async (rps: number) => {
    await fetch("/api/load/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetRps: rps }),
    });
  }, []);

  const stopLoad = useCallback(async () => {
    await fetch("/api/load/stop", { method: "POST" });
  }, []);

  const applyCustom = useCallback(() => {
    const v = Number(custom);
    if (v >= 1) {
      setTarget(v);
      setCustom("");
    }
  }, [custom]);

  const toggleIndex = useCallback(async (on: boolean) => {
    await fetch(`/api/index/${on ? "on" : "off"}`, { method: "POST" });
  }, []);
  const toggleCache = useCallback(async (on: boolean) => {
    await fetch(`/api/cache/${on ? "on" : "off"}`, { method: "POST" });
  }, []);
  const togglePool = useCallback(async (on: boolean) => {
    await fetch(`/api/pool/${on ? "on" : "off"}`, { method: "POST" });
  }, []);
  const toggleCluster = useCallback(async (on: boolean) => {
    await fetch(`/api/cluster/${on ? "on" : "off"}`, { method: "POST" });
    // cluster takes a few seconds to spawn workers / hand back the port;
    // the SSE stream reconnects on its own and shows the new state
    setTimeout(() => {
      fetch("/api/events").catch(() => {});
    }, 3000);
  }, []);

  const status = metrics?.status ?? "healthy";
  const running = metrics?.load.running ?? false;

  const cacheTotal = (metrics?.cache.hits ?? 0) + (metrics?.cache.misses ?? 0);
  const cacheHitRate =
    cacheTotal > 0 ? Math.round(((metrics?.cache.hits ?? 0) / cacheTotal) * 100) : 0;

  const tiles = [
    { label: "Throughput", value: fmt(metrics?.requestsPerSec ?? 0), unit: "req/s", accent: running },
    { label: "Avg latency", value: `${metrics?.avgLatency ?? 0}`, unit: "ms", warn: (metrics?.avgLatency ?? 0) > 200 },
    { label: "P99 latency", value: `${metrics?.p99Latency ?? 0}`, unit: "ms", warn: (metrics?.p99Latency ?? 0) > 1000 },
    { label: "Error rate", value: `${metrics?.errorRate ?? 0}`, unit: "%", warn: (metrics?.errorRate ?? 0) > 1 },
    { label: "CPU", value: `${metrics?.cpuUsage ?? 0}`, unit: "%" },
    { label: "Memory", value: `${metrics?.memoryUsage ?? 0}`, unit: "MB" },
    { label: "Connections", value: `${metrics?.activeConnections ?? 0}`, unit: "" },
    { label: "Total requests", value: fmt(metrics?.totalRequests ?? 0), unit: "" },
  ];

  return (
    <div className="min-h-screen bg-[#0b0b0d] text-zinc-100">
      <div className="mx-auto max-w-[1800px] px-6 py-6 xl:px-10">
        {/* ---------- Header ---------- */}
        <header className="mb-7 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-50">
              API Load Simulator
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              Break it · measure it · fix it — system design by experiment
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-[11px] font-medium tracking-wide ${
                connected
                  ? "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-400"
                  : "border-red-500/20 bg-red-500/[0.06] text-red-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  connected ? "animate-pulse bg-emerald-400" : "bg-red-400"
                }`}
              />
              {connected ? "LIVE" : "OFFLINE"}
            </span>
            <span
              className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                status === "critical"
                  ? "border-red-500/20 bg-red-500/[0.06] text-red-400"
                  : status === "degrading"
                    ? "border-amber-500/20 bg-amber-500/[0.06] text-amber-400"
                    : "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-400"
              }`}
            >
              {status}
            </span>
          </div>
        </header>

        {/* ---------- Load control ---------- */}
        <section className={`${panel} mb-5 flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4`}>
          <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-600">
            Load
          </span>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-[#0b0b0d] p-1">
            {LOAD_LEVELS.map((lvl) => (
              <button
                key={lvl}
                onClick={() => setTarget(lvl)}
                className={`rounded-md px-3.5 py-1.5 text-sm transition-all ${
                  target === lvl
                    ? "bg-zinc-800 font-semibold text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {lvl / 1000}k
              </button>
            ))}
            <div className="mx-0.5 h-5 w-px bg-zinc-800" />
            <input
              value={custom}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "");
                setCustom(v);
                if (v !== "" && Number(v) >= 1) setTarget(Number(v));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCustom();
              }}
              placeholder="custom"
              className="w-20 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
            />
          </div>
          <span className="font-mono text-xs text-zinc-500">
            target <span className="font-semibold text-zinc-200">{fmt(target)}</span> req/s
          </span>

          <div className="flex-1" />

          <button
            onClick={() => startLoad(target)}
            disabled={running}
            className={`rounded-lg px-6 py-2 text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
              running
                ? "bg-zinc-800 text-zinc-500"
                : "bg-orange-600 text-white hover:bg-orange-500"
            }`}
          >
            {running ? "Running" : "Start load"}
          </button>
          <button
            onClick={stopLoad}
            disabled={!running}
            className="rounded-lg border border-zinc-700/70 px-5 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Stop
          </button>
        </section>

        {/* ---------- Metric tiles ---------- */}
        <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          {tiles.map((tile) => (
            <div key={tile.label} className={`${panel} px-4 py-3.5`}>
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
                {tile.label}
              </div>
              <div className="mt-1.5 flex items-baseline gap-1">
                <span
                  className={`text-xl font-semibold tabular-nums ${
                    tile.warn
                      ? "text-red-400"
                      : tile.accent
                        ? "text-orange-300"
                        : "text-zinc-100"
                  }`}
                >
                  {tile.value}
                </span>
                {tile.unit && <span className="text-[11px] text-zinc-600">{tile.unit}</span>}
              </div>
            </div>
          ))}
        </section>

        {/* ---------- Fixes: 2x2 grid ---------- */}
        <section className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-2">
          <FixCard
            name="Database Indexing"
            oneLinerOn={
              metrics?.db.usingIndex
                ? `index seek · ${metrics?.db.avgQueryMs ?? 0} ms avg query`
                : "on — creating index…"
            }
            oneLinerOff={`full table scan of 100k rows · ${metrics?.db.avgQueryMs ?? 0} ms avg query`}
            on={metrics?.db.indexEnabled ?? false}
            onToggle={toggleIndex}
          />
          <FixCard
            name="Redis Caching"
            oneLinerOn={`${cacheHitRate}% hit rate · only misses reach the DB`}
            oneLinerOff="every request queries the database"
            on={metrics?.cache.enabled ?? false}
            onToggle={toggleCache}
          />
          <FixCard
            name="Connection Pooling"
            oneLinerOn="20 pooled connections, reused across requests"
            oneLinerOff="a fresh DB connection for every single request"
            on={metrics?.pool.enabled ?? false}
            onToggle={togglePool}
          />
          <FixCard
            name="Load Balancing"
            oneLinerOn={`${metrics?.cluster.workers ?? 4} instances across CPU cores · round-robin`}
            oneLinerOff="single API instance pinned to one CPU core"
            on={metrics?.cluster.enabled ?? false}
            onToggle={toggleCluster}
          />
        </section>

        {/* ---------- Charts ---------- */}
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className={`${panel} p-4`}>
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
              Throughput
            </h2>
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={points}>
                <defs>
                  <linearGradient id="rpsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f97316" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#f97316" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1a1a1d" vertical={false} />
                <XAxis dataKey="t" hide />
                <YAxis stroke="#3f3f46" width={44} fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip {...chartTooltip} />
                <Area type="monotone" dataKey="rps" stroke="#f97316" strokeWidth={1.5} fill="url(#rpsFill)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className={`${panel} p-4`}>
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
              Latency · ms
            </h2>
            <ResponsiveContainer width="100%" height={170}>
              <LineChart data={points}>
                <CartesianGrid stroke="#1a1a1d" vertical={false} />
                <XAxis dataKey="t" hide />
                <YAxis stroke="#3f3f46" width={44} fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip {...chartTooltip} />
                <Line type="monotone" dataKey="latency" stroke="#38bdf8" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="p99" stroke="#f87171" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className={`${panel} p-4`}>
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
              Errors · %
            </h2>
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={points}>
                <defs>
                  <linearGradient id="errFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ef4444" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1a1a1d" vertical={false} />
                <XAxis dataKey="t" hide />
                <YAxis stroke="#3f3f46" width={44} fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip {...chartTooltip} />
                <Area type="monotone" dataKey="errors" stroke="#ef4444" strokeWidth={1.5} fill="url(#errFill)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className={`${panel} p-4`}>
            <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
              CPU · %
            </h2>
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={points}>
                <defs>
                  <linearGradient id="cpuFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#84cc16" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#84cc16" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1a1a1d" vertical={false} />
                <XAxis dataKey="t" hide />
                <YAxis stroke="#3f3f46" width={44} fontSize={10} tickLine={false} axisLine={false} domain={[0, 100]} />
                <Tooltip {...chartTooltip} />
                <Area type="monotone" dataKey="cpu" stroke="#84cc16" strokeWidth={1.5} fill="url(#cpuFill)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>

        <footer className="mt-5 rounded-xl border border-zinc-800/70 bg-[#111113] px-5 py-3.5 text-xs text-zinc-500">
          <span className="font-medium text-zinc-400">Tip:</span> flip an
          optimization off under load and watch the metrics degrade in real
          time. Flip it back on and watch them recover.
        </footer>
      </div>
    </div>
  );
}
