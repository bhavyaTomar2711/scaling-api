import { NextResponse } from "next/server";

const API = "http://127.0.0.1:4000";

async function proxy(path: string, init?: RequestInit) {
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "backend unreachable" },
      { status: 502 }
    );
  }
}

export async function GET() {
  return proxy("/load/status");
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return proxy("/load/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
