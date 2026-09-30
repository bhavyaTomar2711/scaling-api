"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

type BenchmarkResult = {
  targetRps: number;
  achievedRps: number;
  avgLatency: number;
  p99Latency: number;
  errorRate: number;
  serverCpu: number;
};

type Metrics = {
  timestamp: string;
  requestsPerSec: number;
  avgLatency: number;
  p50Latency: number;
  p99Latency: number;
  errorRate: number;
  cpuUsage: number;
  memoryUsage: number;
  rssMemory: number;
  activeConnections: number;
  totalRequests: number;
  totalErrors: number;
  status: "healthy" | "degrading" | "critical";
  load: { running: boolean; target: number; sent: number; completed: number; errors: number };
  db: {
    avgQueryMs: number;
    queriesPerSec: number;
    indexEnabled: boolean;
    usingIndex: boolean;
    detail: string;
  };
  cache: {
    enabled: boolean;
    hits: number;
    misses: number;
  };
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

export default function Home() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [target, setTarget] = useState(1000);
  const [custom, setCustom] = useState("");
  const [connected, setConnected] = useState(false);
  const [benchRunning, setBenchRunning] = useState(false);
  const [bench, setBench] = useState<{
    before?: BenchmarkResult[];
    after?: BenchmarkResult[];
  }>({});
  const [bench4Running, setBench4Running] = useState(false);
  const [bench4, setBench4] = useState<{
    before?: BenchmarkResult[];
    after?: BenchmarkResult[];
  }>({});
  const pointsRef = useRef<Point[]>([]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
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
      pointsRef.current = [...pointsRef.current.slice(-119), p]; // keep last ~60s
      setPoints(pointsRef.current);
    };
    return () => es.close();
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

  // Custom input always becomes the live target (fixes the stale-target bug)
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

  const runPhase4Benchmark = useCallback(async () => {
    setBench4Running(true);
    try {
      // BEFORE: cache off (index on — Phase 3 fix already applied)
      await fetch("/api/cache/off", { method: "POST" });
      const beforeRes = await fetch("/api/phase4/benchmark", { method: "POST" });
      const before = (await beforeRes.json()).results;
      setBench4((b) => ({ ...b, before }));

      // AFTER: cache on
      await fetch("/api/cache/on", { method: "POST" });
      const afterRes = await fetch("/api/phase4/benchmark", { method: "POST" });
      const after = (await afterRes.json()).results;
      setBench4((b) => ({ ...b, after }));
    } finally {
      setBench4Running(false);
    }
  }, []);

  const runBenchmark = useCallback(async () => {
    setBenchRunning(true);
    try {
      // BEFORE: index off
      await fetch("/api/index/off", { method: "POST" });
      const beforeRes = await fetch("/api/phase3/benchmark", { method: "POST" });
      const before = (await beforeRes.json()).results;
      setBench((b) => ({ ...b, before }));

      // AFTER: index on
      await fetch("/api/index/on", { method: "POST" });
      const afterRes = await fetch("/api/phase3/benchmark", { method: "POST" });
      const after = (await afterRes.json()).results;
      setBench((b) => ({ ...b, after }));
    } finally {
      setBenchRunning(false);
    }
  }, []);

  const status = metrics?.status ?? "healthy";
  const statusColor =
    status === "critical"
      ? "text-red-500"
      : status === "degrading"
        ? "text-yellow-400"
        : "text-green-500";
  const statusDot =
    status === "critical" ? "🔴" : status === "degrading" ? "🟡" : "🟢";

  const fireIntensity = metrics?.load.running
    ? Math.min(5, 1 + Math.floor((metrics.load.target ?? 0) / 800))
    : 0;

  const cacheTotal = (metrics?.cache.hits ?? 0) + (metrics?.cache.misses ?? 0);
  const cacheHitRate =
    cacheTotal > 0
      ? Math.round(((metrics?.cache.hits ?? 0) / cacheTotal) * 100)
      : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-mono p-6">
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <div
            className={`flex h-11 w-11 items-center justify-center rounded-xl text-2xl transition-all duration-500 ${
              fireIntensity > 0
                ? "bg-gradient-to-br from-orange-500/30 to-red-600/20 ring-1 ring-orange-500/40 shadow-[0_0_24px_rgba(249,115,22,0.35)]"
                : "bg-gradient-to-br from-zinc-800 to-zinc-900 ring-1 ring-zinc-700/60"
            }`}
          >
            🔥
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
              API Load Simulator
            </h1>
            <p className="text-xs text-zinc-500">
              Break it · measure it · fix it — system design by experiment
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
              connected
                ? "border-green-500/30 bg-green-500/10 text-green-400"
                : "border-red-500/30 bg-red-500/10 text-red-400"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? "animate-pulse bg-green-400" : "bg-red-400"
              }`}
            />
            {connected ? "LIVE" : "OFFLINE"}
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${statusColor} ${
              status === "critical"
                ? "border-red-500/30 bg-red-500/10"
                : status === "degrading"
                  ? "border-yellow-500/30 bg-yellow-500/10"
                  : "border-green-500/30 bg-green-500/10"
            }`}
          >
            {statusDot} {status.toUpperCase()}
          </span>
        </div>
      </header>

      {/* Control panel */}
      <section
        className={`relative overflow-hidden rounded-2xl border p-5 mb-6 transition-colors duration-500 ${
          metrics?.load.running
            ? "border-orange-500/30 bg-gradient-to-br from-zinc-900 via-zinc-900 to-orange-950/20"
            : "border-zinc-800 bg-zinc-900"
        }`}
      >
        {/* subtle top accent line */}
        <div
          className={`absolute inset-x-0 top-0 h-px transition-opacity duration-500 ${
            metrics?.load.running
              ? "bg-gradient-to-r from-transparent via-orange-500/60 to-transparent opacity-100"
              : "bg-gradient-to-r from-transparent via-zinc-700 to-transparent opacity-60"
          }`}
        />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <span className="text-xs font-medium uppercase tracking-[0.15em] text-zinc-500">
            Load level
          </span>
          <div className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950/60 p-1">
            {LOAD_LEVELS.map((lvl) => (
              <button
                key={lvl}
                onClick={() => setTarget(lvl)}
                className={`rounded-lg px-4 py-1.5 text-sm transition-all ${
                  target === lvl
                    ? "bg-orange-500/15 font-semibold text-orange-300 shadow-[inset_0_0_0_1px_rgba(249,115,22,0.35)]"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {lvl / 1000}k
                <span className="ml-1 text-[10px] text-zinc-600">req/s</span>
              </button>
            ))}
            <div className="mx-1 h-5 w-px bg-zinc-800" />
            <input
              value={custom}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "");
                setCustom(v);
                if (v !== "" && Number(v) >= 1) setTarget(Number(v)); // live-apply
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCustom();
              }}
              placeholder="custom"
              className={`w-20 rounded-lg border bg-transparent px-2.5 py-1.5 text-sm transition-colors focus:outline-none ${
                custom !== "" && Number(custom) >= 1
                  ? "border-orange-500/40 text-orange-300"
                  : "border-transparent text-zinc-300 placeholder-zinc-600 focus:border-orange-500/40"
              }`}
            />
          </div>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors ${
              metrics?.load.running
                ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                : "border-zinc-800 bg-zinc-950/60 text-zinc-500"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                metrics?.load.running
                  ? "animate-pulse bg-orange-400"
                  : "bg-zinc-600"
              }`}
            />
            firing at <span className="font-bold text-zinc-100">{fmt(target)}</span> req/s
          </span>

          <div className="flex-1" />

          <button
            onClick={() => startLoad(target)}
            disabled={metrics?.load.running}
            className="rounded-lg bg-gradient-to-b from-orange-500 to-orange-600 px-7 py-2.5 text-sm font-bold tracking-wide text-white shadow-lg shadow-orange-950/50 transition-all hover:from-orange-400 hover:to-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              transform: `scale(${1 + fireIntensity * 0.03})`,
              boxShadow:
                fireIntensity > 0
                  ? `0 0 ${fireIntensity * 10}px rgba(249,115,22,0.4), 0 10px 20px -8px rgba(0,0,0,0.6)`
                  : "0 10px 20px -8px rgba(0,0,0,0.6)",
            }}
          >
            ▶ START LOAD
          </button>
          <button
            onClick={stopLoad}
            disabled={!metrics?.load.running}
            className="rounded-lg border border-zinc-700 bg-zinc-800/80 px-6 py-2.5 text-sm font-bold tracking-wide text-zinc-300 transition-all hover:border-zinc-500 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ■ STOP
          </button>
        </div>
      </section>

      {/* Metric tiles */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          {
            label: "Target",
            value: metrics?.load.running ? `${fmt(metrics.load.target)}/s` : "—",
          },
          { label: "Actual req/s", value: fmt(metrics?.requestsPerSec ?? 0) },
          {
            label: "Avg latency",
            value: `${metrics?.avgLatency ?? 0} ms`,
            warn: (metrics?.avgLatency ?? 0) > 200,
          },
          {
            label: "P99 latency",
            value: `${metrics?.p99Latency ?? 0} ms`,
            warn: (metrics?.p99Latency ?? 0) > 1000,
          },
          {
            label: "Error rate",
            value: `${metrics?.errorRate ?? 0}%`,
            warn: (metrics?.errorRate ?? 0) > 1,
          },
          { label: "CPU", value: `${metrics?.cpuUsage ?? 0}%` },
          { label: "Memory", value: `${metrics?.memoryUsage ?? 0} MB` },
          { label: "Total reqs", value: fmt(metrics?.totalRequests ?? 0) },
        ].map((tile) => (
          <div
            key={tile.label}
            className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"
          >
            <div className="text-xs text-zinc-500 mb-1">{tile.label}</div>
            <div
              className={`text-xl font-bold ${
                tile.warn ? "text-red-400" : "text-zinc-100"
              }`}
            >
              {tile.value}
            </div>
          </div>
        ))}
      </section>

      {/* Phase 3: Database indexing panel */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-6">
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <h2 className="text-sm font-semibold tracking-wide text-zinc-200">
            Fix #1 — Database Indexing
          </h2>
          <span
            className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
              metrics?.db.indexEnabled
                ? "border-green-500/30 bg-green-500/10 text-green-400"
                : "border-zinc-700 bg-zinc-800/60 text-zinc-400"
            }`}
          >
            {metrics?.db.indexEnabled ? "✅ INDEX ON" : "⬜ INDEX OFF · full table scan"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => toggleIndex(false)}
              className={`px-3 py-1 rounded text-xs ${
                !metrics?.db.indexEnabled
                  ? "bg-zinc-700 text-zinc-200"
                  : "border border-zinc-700 text-zinc-500 hover:border-zinc-500"
              }`}
            >
              index OFF
            </button>
            <button
              onClick={() => toggleIndex(true)}
              className={`px-3 py-1 rounded text-xs ${
                metrics?.db.indexEnabled
                  ? "bg-green-600 text-white"
                  : "border border-green-700 text-green-400 hover:border-green-500"
              }`}
            >
              index ON
            </button>
          </div>
          <div className="flex-1" />
          <button
            onClick={runBenchmark}
            disabled={benchRunning || metrics?.load.running}
            className="rounded-lg bg-gradient-to-b from-sky-500 to-sky-600 px-4 py-1.5 text-sm font-bold text-white shadow-md shadow-sky-950/40 transition-all hover:from-sky-400 hover:to-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {benchRunning ? "⏳ Running before/after (~1 min)..." : "▶ Run Before/After Benchmark"}
          </button>
        </div>

        <div className="text-xs text-zinc-500 mb-3 font-mono">
          Query plan: {metrics?.db.detail ?? "—"} · avg query: {metrics?.db.avgQueryMs ?? 0} ms ·{" "}
          {metrics?.db.queriesPerSec ?? 0} queries/s
        </div>

        {bench.before && bench.after && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-800">
                <th className="text-left py-1.5">Load</th>
                <th className="text-right py-1.5">Before (scan) latency</th>
                <th className="text-right py-1.5">After (index) latency</th>
                <th className="text-right py-1.5">Improvement</th>
                <th className="text-right py-1.5">Before rps</th>
                <th className="text-right py-1.5">After rps</th>
              </tr>
            </thead>
            <tbody>
              {bench.before.map((b, i) => {
                const a = bench.after?.[i];
                if (!a) return null;
                const improvement =
                  b.avgLatency > 0
                    ? Math.round((1 - a.avgLatency / b.avgLatency) * 100)
                    : 0;
                return (
                  <tr key={b.targetRps} className="border-b border-zinc-800/50">
                    <td className="py-1.5 text-zinc-300">{b.targetRps}/s</td>
                    <td className="py-1.5 text-right text-red-400">{b.avgLatency.toFixed(0)} ms</td>
                    <td className="py-1.5 text-right text-green-400">{a.avgLatency.toFixed(0)} ms</td>
                    <td className="py-1.5 text-right font-bold text-sky-400">{improvement}% ↓</td>
                    <td className="py-1.5 text-right text-zinc-500">{b.achievedRps}</td>
                    <td className="py-1.5 text-right text-zinc-300">{a.achievedRps}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Phase 4: Redis caching panel */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-6">
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <h2 className="text-sm font-semibold tracking-wide text-zinc-200">
            Fix #2 — Redis Caching (5-min TTL)
          </h2>
          <span
            className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
              metrics?.cache.enabled
                ? "border-green-500/30 bg-green-500/10 text-green-400"
                : "border-zinc-700 bg-zinc-800/60 text-zinc-400"
            }`}
          >
            {metrics?.cache.enabled ? "✅ CACHE ON" : "⬜ CACHE OFF · every request hits the DB"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => toggleCache(false)}
              className={`px-3 py-1 rounded text-xs ${
                !metrics?.cache.enabled
                  ? "bg-zinc-700 text-zinc-200"
                  : "border border-zinc-700 text-zinc-500 hover:border-zinc-500"
              }`}
            >
              cache OFF
            </button>
            <button
              onClick={() => toggleCache(true)}
              className={`px-3 py-1 rounded text-xs ${
                metrics?.cache.enabled
                  ? "bg-green-600 text-white"
                  : "border border-green-700 text-green-400 hover:border-green-500"
              }`}
            >
              cache ON
            </button>
          </div>
          <div className="flex-1" />
          <button
            onClick={runPhase4Benchmark}
            disabled={bench4Running || metrics?.load.running}
            className="rounded-lg bg-gradient-to-b from-sky-500 to-sky-600 px-4 py-1.5 text-sm font-bold text-white shadow-md shadow-sky-950/40 transition-all hover:from-sky-400 hover:to-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {bench4Running ? "⏳ Running before/after (~2 min)..." : "▶ Run Before/After Benchmark"}
          </button>
        </div>

        <div className="text-xs text-zinc-500 mb-3 font-mono">
          Hit rate: <span className="text-zinc-300 font-bold">{cacheHitRate}%</span> ·{" "}
          {metrics?.cache.hits ?? 0} hits · {metrics?.cache.misses ?? 0} misses · DB queries/s:{" "}
          <span className="text-zinc-300">{metrics?.db.queriesPerSec ?? 0}</span>
        </div>

        {bench4.before && bench4.after && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-800">
                <th className="text-left py-1.5">Load</th>
                <th className="text-right py-1.5">Before (no cache) latency</th>
                <th className="text-right py-1.5">After (Redis) latency</th>
                <th className="text-right py-1.5">Improvement</th>
                <th className="text-right py-1.5">Before rps</th>
                <th className="text-right py-1.5">After rps</th>
              </tr>
            </thead>
            <tbody>
              {bench4.before.map((b, i) => {
                const a = bench4.after?.[i];
                if (!a) return null;
                const improvement =
                  b.avgLatency > 0
                    ? Math.round((1 - a.avgLatency / b.avgLatency) * 100)
                    : 0;
                return (
                  <tr key={b.targetRps} className="border-b border-zinc-800/50">
                    <td className="py-1.5 text-zinc-300">{b.targetRps}/s</td>
                    <td className="py-1.5 text-right text-red-400">{b.avgLatency.toFixed(0)} ms</td>
                    <td className="py-1.5 text-right text-green-400">{a.avgLatency.toFixed(0)} ms</td>
                    <td className="py-1.5 text-right font-bold text-sky-400">{improvement}% ↓</td>
                    <td className="py-1.5 text-right text-zinc-500">{b.achievedRps}</td>
                    <td className="py-1.5 text-right text-zinc-300">{a.achievedRps}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Charts */}
      <section className="grid md:grid-cols-2 gap-6">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm text-zinc-400 mb-3">
            Requests/sec (last ~60s)
          </h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points}>
              <CartesianGrid stroke="#27272a" />
              <XAxis dataKey="t" hide />
              <YAxis stroke="#71717a" width={60} />
              <Tooltip
                contentStyle={{ background: "#18181b", border: "#27272a" }}
                labelFormatter={() => ""}
              />
              <Line
                type="monotone"
                dataKey="rps"
                stroke="#f97316"
                dot={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm text-zinc-400 mb-3">Latency (ms)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points}>
              <CartesianGrid stroke="#27272a" />
              <XAxis dataKey="t" hide />
              <YAxis stroke="#71717a" width={60} />
              <Tooltip
                contentStyle={{ background: "#18181b", border: "#27272a" }}
                labelFormatter={() => ""}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="latency"
                name="avg"
                stroke="#38bdf8"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="p99"
                name="p99"
                stroke="#ef4444"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm text-zinc-400 mb-3">Error rate (%)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points}>
              <CartesianGrid stroke="#27272a" />
              <XAxis dataKey="t" hide />
              <YAxis stroke="#71717a" width={60} />
              <Tooltip
                contentStyle={{ background: "#18181b", border: "#27272a" }}
                labelFormatter={() => ""}
              />
              <Line
                type="monotone"
                dataKey="errors"
                stroke="#ef4444"
                dot={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm text-zinc-400 mb-3">CPU (%)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points}>
              <CartesianGrid stroke="#27272a" />
              <XAxis dataKey="t" hide />
              <YAxis stroke="#71717a" width={60} domain={[0, 100]} />
              <Tooltip
                contentStyle={{ background: "#18181b", border: "#27272a" }}
                labelFormatter={() => ""}
              />
              <Line
                type="monotone"
                dataKey="cpu"
                stroke="#a3e635"
                dot={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <footer className="mt-8 text-xs text-zinc-600">
        Phase 4 — Redis caching on top of the indexed query. Cache ON + index
        ON is the current best config: most requests never touch the DB.
        Toggle each fix and benchmark to see the stack effect.
      </footer>
    </div>
  );
}
