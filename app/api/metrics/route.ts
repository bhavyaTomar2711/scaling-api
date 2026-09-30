import { NextResponse } from "next/server";

const API = "http://127.0.0.1:4000";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch(`${API}/metrics`, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "backend unreachable" },
      { status: 502 }
    );
  }
}
