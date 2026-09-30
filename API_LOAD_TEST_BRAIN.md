# API Load Testing Simulator - Project Brain

## Overview
Build a system design learning tool where you progressively overload an API, watch it break in real-time on a cute dashboard, apply fixes, and see metrics improve. No theory, pure experimentation.

---

## Tech Stack

**Backend:**
- Node.js/Express (simplest to iterate)
- SQLite (locally, no setup)
- Redis (optional, for caching phase)

**Frontend:**
- Next.js (for the control panel)
- Real-time metrics via WebSockets or Server-Sent Events (SSE)
- Charts: Recharts (simple, lightweight)

**Load Testing:**
- Locust (Python) - easy to understand, visual UI

**Metrics Tracking:**
- Node.js: `os` module + custom middleware to track CPU, memory, response times, error rates

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Next.js Frontend                       │
│         (Control Panel + Real-Time Metrics Dashboard)     │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket/SSE
                       ↓
┌─────────────────────────────────────────────────────────┐
│              Express API + Metrics Server                 │
│  (Core API endpoints + real-time metrics broadcaster)    │
└──────────────────────┬──────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ↓             ↓             ↓
      SQLite        Redis         OS Metrics
    (Database)    (Cache)    (CPU, Memory, etc)
         
         
┌─────────────────────────────────────────────────────────┐
│              Locust (Load Testing Tool)                   │
│           Runs separately, hammers the API                │
└─────────────────────────────────────────────────────────┘
```

---

## Phase Breakdown

### PHASE 1: Baby API (Unoptimized, No Load)
**Goal:** Create a basic API that works fine at low load. Establish baseline.

**What to build:**
- Express server with 1 endpoint: `GET /users/:id`
- SQLite database with `users` table (id, name, email, created_at)
- Seed 10k rows (big enough to be realistic, fast to load)
- Dumb query: No indexing, no caching, single query per request
- Middleware to track: response time, request count, errors, CPU, memory
- Expose metrics endpoint: `GET /metrics` returns JSON
- WebSocket/SSE for real-time metrics broadcast

**Frontend:**
- Load level selector: [5k] [10k] [15k] [Custom input]
- "🔥 Fire Button" that starts the load test
- Real-time counter: requests/sec (actual vs target), avg response time, error count
- Status indicator: 🟢 Healthy | 🟡 Degrading | 🔴 Critical

**What you'll learn:**
- Baseline performance (should be fast at 5k: ~10-20ms per request)

**Time estimate:** 2-3 hours

---

### PHASE 2: Multi-Level Stress Test (5k → 10k → 15k requests/sec)
**Goal:** Watch the API progressively degrade at each load level. Identify exact breaking points.

**What to do:**
- Run Locust at 5k req/s → should handle fine
- Rerun at 10k req/s → watch degradation start
- Rerun at 15k req/s → watch it fall apart completely

**Expected results:**
- At 5k: Response time ~20ms, 0% error rate
- At 10k: Response time ~150ms, 5% error rate
- At 15k: Response time ~2000ms+, 30%+ error rate, timeouts

**Frontend:**
- Show all three load levels as separate runs
- Color-coded graphs: Green (5k) → Yellow (10k) → Red (15k)
- Display: "API breaks at 12.3k req/s" (exact breaking point)
- Show per-load-level metrics

**What you'll learn:**
- Single-threaded bottleneck severity
- Database query performance is THE bottleneck
- Connection limits matter
- Where your unoptimized API actually breaks

**Time estimate:** 1-2 hours (mostly watching)

---

### PHASE 3: Apply Fix #1 - Database Indexing
**Goal:** Apply first optimization, see immediate improvement.

**What to do:**
- Add index on `users.id`
- Test at all three load levels: 5k, 10k, 15k
- Compare metrics before/after at EACH level

**Before indexing:**
- 5k req/s: 20ms latency
- 10k req/s: 500ms latency
- 15k req/s: 3000ms latency, 40% errors

**After indexing:**
- 5k req/s: 8ms latency
- 10k req/s: 120ms latency
- 15k req/s: 1200ms latency, 15% errors

**Frontend:**
- Show before/after side-by-side for each load level
- Highlight: "Indexing reduced latency by 60-75%"
- Show improvement is proportional across all levels

**What you'll learn:**
- Database performance fundamentals
- Query optimization impacts all load levels
- Why indexing is critical for scaling

**Time estimate:** 1 hour

---

### PHASE 4: Apply Fix #2 - Caching (Redis)
**Goal:** Reduce database load with caching. Handle higher loads now.

**What to do:**
- Add Redis (run locally via Docker or install)
- Cache user lookups for 5 mins
- Test at 5k, 10k, 15k again
- Watch database queries drop drastically

**Before caching:**
- 15k req/s: 1200ms latency, 15% errors, 15k DB queries/sec

**After caching:**
- 15k req/s: 80ms latency, <1% errors, 50 DB queries/sec (mostly cache hits)

**Frontend:**
- Show "Cache Hit Rate" metric (should be 98%+)
- Display: "Redis reduced database load by 99%"
- Show: You can now handle 15k smoothly when you couldn't before

**What you'll learn:**
- Caching is the nuclear option for scaling
- Memory trade-off for speed is worth it
- Why hot data caching matters most
- Cache hit rates are everything

**Time estimate:** 2-3 hours (Redis setup + implementation)

---

### PHASE 5: Apply Fix #3 - Connection Pooling
**Goal:** Manage database connections efficiently under high load.

**What to do:**
- Currently: new connection per request (wasteful)
- Add connection pool (e.g., node-postgres with pooling)
- Max connections: 20-50
- Test at 5k, 10k, 15k
- Watch connection queue behavior

**Before pooling:**
- 15k req/s: Connections exhausted, requests queue up, latency spikes
- Connection wait time: 200ms average

**After pooling:**
- 15k req/s: Connections reused efficiently
- Connection wait time: <5ms
- Throughput increase: 20-30%

**Frontend:**
- Show: Active connections, queue length, wait time
- Display per-load-level: Connection efficiency improves most at 15k

**What you'll learn:**
- Connection pooling prevents resource exhaustion
- Why max connections matter
- Queue behavior under load
- Connection reuse is free performance

**Time estimate:** 1-2 hours

---

### PHASE 6: Apply Fix #4 - Async Processing (Background Jobs)
**Goal:** Handle heavy operations without blocking fast requests.

**What to do:**
- Add a "slow operation" endpoint (e.g., `/users/:id/export` - takes 5 seconds)
- Without optimization: blocks event loop, kills throughput
- Add job queue (Bull or simple async queue)
- Process jobs in background, return immediately
- Test mixed load: 80% fast requests + 20% slow requests at 10k

**Before async:**
- Fast requests avg 80ms (delayed by slow requests)
- Only 3k req/s max throughput

**After async:**
- Fast requests avg 40ms (unaffected)
- 10k req/s throughput maintained
- Slow jobs queued and processed separately

**Frontend:**
- Show: Queue length, processing rate, fast vs slow request latency
- Display: "Slow operations no longer block fast requests"

**What you'll learn:**
- Async processing is critical for mixed-workload apps
- Job queues decouple request/response from processing
- Throughput vs latency are separate concerns

**Time estimate:** 2-3 hours

---

### PHASE 7: Apply Fix #5 - Load Balancing (Simulate)
**Goal:** Scale horizontally to handle even higher loads.

**What to do:**
- Spawn multiple API instances (2-3 on same laptop)
- Put them behind simple load balancer (nginx or manual round-robin)
- Test at 15k again (load distributed across instances)
- Watch CPU/memory distributed across processes

**Before load balancing:**
- 1 instance at 15k: Single process at 95% CPU, can't scale more
- Bottleneck: CPU

**After load balancing:**
- 2 instances at 15k: Each at ~50% CPU, handled smoothly
- 3 instances at 30k: Each at ~50% CPU (you can now handle 2x load)

**Frontend:**
- Show: Per-instance CPU/memory, total throughput
- Display: "2 instances handling 15k = each handles 7.5k smoothly"
- Show throughput scaling: 1 instance = 15k max, 2 instances = 30k possible

**What you'll learn:**
- Horizontal scaling is fundamentally different from vertical
- Load distribution complexity
- Why servers need load balancers
- Bottleneck shifts from CPU → network → database

**Time estimate:** 2 hours

---

### PHASE 8: Fun Experiments (Optional)
Pick any of these and test at 5k/10k/15k:

**A) Circuit Breaker Pattern**
- When database is overloaded, reject new requests gracefully
- Watch error rate drop (fast fails > slow hangs)
- Test: At 15k, circuit breaker kicks in at ~12k, maintains 12k throughput with 0% errors instead of 50% errors at 15k

**B) Rate Limiting (Per-User)**
- Cap requests per user (e.g., 100 req/s per user)
- Distribute 15k load across 200 users
- Watch how it protects your API from power users
- Compare: With vs without rate limiting at 15k

**C) Database Read Replicas (Simulated)**
- Simulate 2 read-only databases + 1 write
- Route reads to replica randomly
- Test at 15k (mostly reads)
- Watch throughput increase, query latency decrease

**D) Response Compression (Gzip)**
- Gzip JSON responses
- Test bandwidth savings at 15k req/s
- Watch: Network throughput reduction (~60-70% for JSON)

**E) Request Batching**
- Instead of 1 request per user lookup, batch 10 lookups
- Test: 1500 batch requests = 15k user lookups
- Compare latency/throughput

**Time estimate:** 1-2 hours each

---

## Frontend Control Panel (The Fun Part)

```
┌─────────────────────────────────────────────────────────┐
│                  🔥 API Load Simulator 🔥                 │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  Current Status: [🟢 RUNNING] [🔴 STOPPED]               │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Select Load Level:                               │ │
│  │  [5k] [10k] [15k] [Custom: ____ req/s]            │ │
│  │                                                     │ │
│  │         🔥 START LOAD TEST        [STOP]           │ │
│  │  Duration: [1m] [5m] [Until manual stop]           │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌───────────────────────┬───────────────────────────┐   │
│  │ Target: 10k req/s     │ Actual: 9,847 req/s       │   │
│  │ Avg Latency: 245ms ↗  │ Error Rate: 2.1% ⚠️      │   │
│  │ P99 Latency: 1203ms   │ CPU: 67% | Memory: 521MB │   │
│  │ Total Requests: 31.4k │ Breaking Point: ~12.3k   │   │
│  └───────────────────────┴───────────────────────────┘   │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Response Time Over Time (last 5 mins)            │ │
│  │  [Graph showing: 5k=green, 10k=yellow, 15k=red]   │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Load Level Comparison:                           │ │
│  │  5k req/s  → Latency: 18ms  | Errors: 0%  ✅      │ │
│  │  10k req/s → Latency: 156ms | Errors: 4%  ⚠️      │ │
│  │  15k req/s → Latency: 2145ms| Errors: 31% 🔴      │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Current Optimizations Applied:                   │ │
│  │  ✅ Database Indexing                             │ │
│  │  ✅ Redis Caching                                 │ │
│  │  ✅ Connection Pooling                            │ │
│  │  ⬜ Load Balancing (not applied)                   │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Fix Impact Comparison:                           │ │
│  │  Before Fix #2 (Redis): 850ms @ 10k req/s         │ │
│  │  After Fix #2 (Redis):  180ms @ 10k req/s         │ │
│  │  Improvement: 79% ↓                               │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

**Key Metrics to Display:**
- Requests/sec (live counter, red if degrading)
- Response time (avg, P50, P99)
- Error rate (show red when > 1%)
- CPU % (graph over time)
- Memory usage (MB)
- Database query count (with/without cache)
- Active connections
- Queue length

**Fun Features:**
- "Fire Button" animations (🔥 grows bigger as load increases)
- Color coding: 🟢 Green (healthy), 🟡 Yellow (warning), 🔴 Red (critical)
- Before/After comparison cards for each fix
- "Breakdown Moment" indicator - shows exactly when API starts failing
- Replay mode - re-run same load test and compare

---

## Real-Time Metrics (Backend)

Every 500ms, broadcast:
```json
{
  "timestamp": "2024-09-30T10:45:23.000Z",
  "requestsPerSec": 523,
  "avgLatency": 245,
  "p99Latency": 1203,
  "errorRate": 2.1,
  "cpuUsage": 67,
  "memoryUsage": 521,
  "activeConnections": 18,
  "queueLength": 4,
  "cacheHitRate": 85,
  "totalRequests": 31400,
  "totalErrors": 678
}
```

Send via WebSocket or SSE to frontend. Frontend plots in real-time.

---

## Learning Path (What You'll Understand)

After Phase 7, you'll understand:
- ✅ Database optimization fundamentals (indexing, connection pooling)
  - *Why* queries matter, *how much* they impact at different loads
- ✅ Caching strategies (when, why, trade-offs, 99% hit rates)
  - *Exactly* how much caching helps at each load level
- ✅ Async processing (blocking vs non-blocking, job queues)
  - Why you can't block on slow operations at scale
- ✅ Horizontal vs vertical scaling (real, not theoretical)
  - 1 instance = 15k max, 2 instances = 30k possible
- ✅ Load balancing (actual routing and distribution)
  - Why you need it, how it distributes load, CPU optimization
- ✅ Bottleneck identification (CPU vs I/O vs memory vs DB vs connections)
  - *Which* bottleneck is limiting you at each phase
- ✅ Real-time monitoring & metrics (what to track, how to interpret)
- ✅ API performance under progressive stress (5k → 10k → 15k)
- ✅ Breaking points and graceful degradation
- ✅ Optimization impact quantification (60% improvement is visceral, not theoretical)

This is **90%+ of system design interviews + real production knowledge.**

You'll be able to:
- Design an API for scale confidently
- Predict where things break
- Know which optimization to apply first
- Understand trade-offs between solutions
- Explain with *proof*, not theory

---

## Build Order (Recommended)

1. **Day 1:** Phase 1 + Phase 2 (API + test at 5k/10k/15k)
2. **Day 2:** Phase 3 (Indexing) - test improvements at each load level
3. **Day 3:** Phase 4 (Caching) - watch 15k become smooth
4. **Day 4:** Phase 5 + Phase 6 (Connection pooling + Async jobs)
5. **Day 5:** Phase 7 (Load balancing) - scale to 30k
6. **Day 6:** Polish frontend, add Phase 8 experiments (optional)

Total: 5-6 days of focused work. Portfolio absolute gold (understanding system design + implementation).

---

## Repository Structure

```
api-load-simulator/
├── backend/
│   ├── index.js (Express server)
│   ├── db.js (SQLite setup)
│   ├── metrics.js (metrics tracking)
│   ├── locustfile.py (Locust load test config)
│   ├── package.json
│   └── .env
│
├── frontend/
│   ├── app/
│   │   ├── page.tsx (Control panel)
│   │   └── layout.tsx
│   ├── components/
│   │   ├── Dashboard.tsx
│   │   ├── MetricsGraph.tsx
│   │   ├── ControlPanel.tsx
│   │   └── ComparisonCard.tsx
│   ├── lib/
│   │   └── websocket.ts (Real-time connection)
│   └── package.json
│
└── README.md (Complete setup instructions)
```

---

## Success Criteria

- ✅ Can start/stop load tests from frontend with one click (fire button)
- ✅ Can switch between 5k/10k/15k req/s load levels instantly
- ✅ Real-time metrics update on dashboard (< 1 second delay)
- ✅ See API break at 15k req/s (baseline, unoptimized)
- ✅ Each fix measurably improves metrics at ALL load levels (before/after visible)
- ✅ Can compare performance at 5k/10k/15k side-by-side
- ✅ Understand WHY each fix works, not just that it works
- ✅ Can explain to someone: "Here's what happens when you index a database" + "Here's why it matters at 15k req/s" with proof
- ✅ After all fixes, smoothly handle 15k req/s (was impossible before)

---

## Fun Factor

- Watch the 🔥 button light up when you hammer the API
- See metrics go red in real-time (satisfying to watch)
- Apply a fix and watch metrics improve immediately (dopamine hit)
- Before/after comparisons are visceral (79% improvement feels good)
- Experiment mode: try random optimizations, see what works
- Screenshot/compare phases for portfolio

---

## Next Level (After You're Done)

- Deploy on cloud (AWS/GCP) and see real scaling
- Add chaos engineering (kill connections, simulate network delays)
- Multi-region load balancing simulation
- Database replication simulation
- API rate limiting strategies
- Caching strategies comparison (TTL, LRU, etc)

---

## Tools You'll Learn

- Node.js/Express
- SQLite/PostgreSQL
- Redis
- WebSockets/SSE
- Locust (load testing)
- System metrics monitoring
- Real-time data visualization

All valuable, all used in real jobs.

---

**This is a genuinely good project. Build it. Learn system design by doing, not watching.**
