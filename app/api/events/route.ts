import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const API = "http://127.0.0.1:4000";

// SSE passthrough: pipes the backend's real-time metrics stream to the browser
export async function GET() {
  const backend = await fetch(`${API}/events`, {
    cache: "no-store",
    headers: { Accept: "text/event-stream" },
  }).catch(() => null);

  if (!backend || !backend.body) {
    return new NextResponse("backend unreachable", { status: 502 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = backend.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        // client disconnected or backend closed
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
    cancel() {
      backend.body?.cancel();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
