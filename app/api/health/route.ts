import { NextResponse } from "next/server";

const API = "http://127.0.0.1:4000";

export async function GET() {
  try {
    const res = await fetch(`${API}/users/42`, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json({ ok: true, sample: data });
  } catch {
    return NextResponse.json(
      { ok: false, error: "backend unreachable" },
      { status: 502 }
    );
  }
}
