import { NextResponse } from "next/server";

const API = "http://127.0.0.1:4000";

export async function POST() {
  try {
    const res = await fetch(`${API}/load/stop`, {
      method: "POST",
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
