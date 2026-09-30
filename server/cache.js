import Redis from "ioredis";
import { isIndexEnabled } from "./db.js";

// Phase 4: Caching layer with a real Redis server (redis-bin/redis-server.exe
// on localhost:6379). Caches user lookups for 5 minutes.

const CACHE_TTL_SEC = 300; // 5 minutes

const redis = new Redis({
  host: "127.0.0.1",
  port: 6379,
  lazyConnect: false,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
});

redis.on("error", (err) => {
  // Don't spam logs; the dashboard shows driver status
  if (!cacheState.redisErrorLogged) {
    console.error("[cache] Redis error:", err.message);
    cacheState.redisErrorLogged = true;
  }
});
redis.on("connect", () => {
  cacheState.redisErrorLogged = false;
});

// ---- Cache state & stats ----
export const cacheState = {
  enabled: false, // the FIX switch (Phase 4)
  driver: "redis", // "redis" | "memory" (fallback)
  hits: 0,
  misses: 0,
  sets: 0,
  errors: 0,
  redisErrorLogged: false,
};

// In-memory fallback in case Redis is unreachable (keeps the demo working)
const memCache = new Map(); // key -> { value, expiresAt }

function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memCache.delete(key);
    return null;
  }
  return entry.value;
}
function memSet(key, value) {
  memCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_SEC * 1000 });
  if (memCache.size > 50000) {
    // crude eviction: drop oldest entries
    const it = memCache.keys();
    for (let i = 0; i < 5000; i++) {
      const k = it.next().value;
      if (k === undefined) break;
      memCache.delete(k);
    }
  }
}

export async function cacheGetUser(id) {
  const key = `user:${id}`;
  if (cacheState.driver === "redis") {
    try {
      const raw = await redis.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      cacheState.driver = "memory"; // degrade gracefully
    }
  }
  return memGet(key);
}

export async function cacheSetUser(id, user) {
  const key = `user:${id}`;
  const raw = JSON.stringify(user);
  if (cacheState.driver === "redis") {
    try {
      await redis.set(key, raw, "EX", CACHE_TTL_SEC);
      return;
    } catch {
      cacheState.driver = "memory";
    }
  }
  memSet(key, raw ? user : user);
}

export function recordCacheHit() {
  cacheState.hits++;
}
export function recordCacheMiss() {
  cacheState.misses++;
}

export function setCacheEnabled(enabled) {
  cacheState.enabled = enabled;
  if (enabled) {
    // flush stale cache when turning on so metrics start clean
    flushCache();
  }
  return cacheState.enabled;
}

export async function flushCache() {
  cacheState.hits = 0;
  cacheState.misses = 0;
  try {
    await redis.flushdb();
  } catch {
    // ignore
  }
  memCache.clear();
}

export async function getCacheInfo() {
  let redisUp = false;
  try {
    redisUp = (await redis.ping()) === "PONG";
    if (redisUp && cacheState.driver === "memory") cacheState.driver = "redis";
  } catch {
    redisUp = false;
  }
  const total = cacheState.hits + cacheState.misses;
  return {
    enabled: cacheState.enabled,
    driver: redisUp ? "redis" : "memory",
    redisUp,
    ttlSec: CACHE_TTL_SEC,
    hits: cacheState.hits,
    misses: cacheState.misses,
    hitRate: total > 0 ? Math.round((cacheState.hits / total) * 10000) / 100 : 0,
    keys: redisUp ? await redis.dbsize() : memCache.size,
  };
}

// Cached lookup wrapper: returns { user, cacheHit }
export async function getUserCached(id, dbLookup) {
  if (!cacheState.enabled) {
    const user = dbLookup();
    return { user, cacheHit: false };
  }
  const cached = await cacheGetUser(id);
  if (cached) {
    recordCacheHit();
    return { user: cached, cacheHit: true };
  }
  recordCacheMiss();
  const user = dbLookup();
  if (user) await cacheSetUser(id, user);
  return { user, cacheHit: false };
}
