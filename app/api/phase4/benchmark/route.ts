import { NextResponse } from "next/server";

const API = "http://127.0.0.1:4000";

export const maxDuration = 300; // benchmark takes ~2 min

// Proxy: POST /api/phase4/benchmark — runs 1k/2k/3k at current cache state
export async function POST() {
  try {
    const res = await fetch(`${API}/phase4/benchmark`, {
      method: "POST",
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
