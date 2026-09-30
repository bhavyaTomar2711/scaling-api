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

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-mono p-6">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">🔥 API Load Simulator</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className={connected ? "text-green-500" : "text-red-500"}>
            {connected ? "● live" : "○ disconnected"}
          </span>
          <span className={statusColor}>
            {statusDot} {status.toUpperCase()}
          </span>
        </div>
      </header>

      {/* Control panel */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-zinc-400 text-sm">Load level:</span>
          {LOAD_LEVELS.map((lvl) => (
            <button
              key={lvl}
              onClick={() => setTarget(lvl)}
              className={`px-4 py-1.5 rounded-md border text-sm transition-colors ${
                target === lvl
                  ? "border-orange-500 bg-orange-500/10 text-orange-400"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
              }`}
            >
              {lvl / 1000}k req/s
            </button>
          ))}
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
            className="w-24 px-3 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-sm"
          />
          <span className="text-xs text-zinc-500">
            firing at {fmt(target)} req/s
          </span>

          <div className="flex-1" />

          <button
            onClick={() => startLoad(target)}
            disabled={metrics?.load.running}
            className="px-6 py-2 rounded-md bg-orange-600 hover:bg-orange-500 disabled:opacity-40 font-bold text-lg transition-all"
            style={{
              transform: `scale(${1 + fireIntensity * 0.04})`,
              boxShadow: fireIntensity > 0 ? `0 0 ${fireIntensity * 8}px rgba(249,115,22,.5)` : "none",
            }}
          >
            {"🔥".repeat(Math.max(1, fireIntensity))} START LOAD
          </button>
          <button
            onClick={stopLoad}
            disabled={!metrics?.load.running}
            className="px-6 py-2 rounded-md bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 font-bold"
          >
            STOP
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
          <h2 className="text-sm font-bold text-zinc-300">🛠 Fix #1 — Database Indexing</h2>
          <span
            className={`text-xs px-2 py-0.5 rounded ${
              metrics?.db.indexEnabled
                ? "bg-green-500/10 text-green-400"
                : "bg-zinc-700/50 text-zinc-400"
            }`}
          >
            {metrics?.db.indexEnabled ? "✅ INDEX ON" : "⬜ index off (full table scan)"}
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
            className="px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-sm font-bold"
          >
            {benchRunning ? "running before/after (~1 min)..." : "▶ Run Before/After Benchmark (1k/2k/3k)"}
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
        Phase 3 — same dumb query, with and without an expression index on
        LOWER(email). Toggle the index and watch avg query time and the
        breaking point shift. Levels are laptop-scaled.
      </footer>
    </div>
  );
}
