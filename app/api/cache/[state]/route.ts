import { NextResponse } from "next/server";

const API = "http://127.0.0.1:4000";

// Proxy: POST /api/cache/on | /api/cache/off — toggle the Redis cache
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ state: string }> }
) {
  const { state } = await params;
  try {
    const res = await fetch(`${API}/cache/${state}`, {
      method: "POST",
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}
