import { NextResponse } from "next/server";

// Cluster control goes to the dedicated control port (4199), NOT the
// load-balanced port 4000 — once the balancer is active, only the main
// process may toggle the cluster.
const CONTROL = "http://127.0.0.1:4199";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ state: string }> }
) {
  const { state } = await params;
  try {
    const res = await fetch(`${CONTROL}/cluster/${state}`, {
      method: "POST",
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    // toggle runs in the background; SSE reconnect will reflect the state
    return NextResponse.json({ ok: true, pending: true });
  }
}
