import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const API = "http://127.0.0.1:4000";

// SSE passthrough: pipes the backend's real-time metrics stream to the browser.
// During a cluster port-switch, port 4000 is briefly dead. We MUST return a
// valid SSE response (200 + text/event-stream) even then, otherwise the
// browser's EventSource treats a non-200 as a permanent failure and stops
// reconnecting entirely (per the HTML spec).
export async function GET() {
  // Try to connect to the backend, with a short retry for the cluster gap
  let backend = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    backend = await fetch(`${API}/events`, {
      cache: "no-store",
      headers: { Accept: "text/event-stream" },
    }).catch(() => null);
    if (backend?.body) break;
    backend = null;
    await new Promise((r) => setTimeout(r, 1000)); // wait 1s between retries
  }

  if (!backend || !backend.body) {
    // Return a VALID SSE response so EventSource stays in reconnect mode.
    // The "retry: 2000" instruction tells the browser to try again in 2s.
    return new NextResponse("retry: 2000\nevent: reconnect\ndata: backend starting\n\n", {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  // Single reader created in start(); cancel() signals it via the flag
  // instead of touching the stream again (avoids "ReadableStream is locked").
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let aborted = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = backend.body!.getReader();
      try {
        for (;;) {
          if (aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch {
        // client disconnected or backend closed — nothing to do
      } finally {
        try {
          reader?.releaseLock();
        } catch {
          // already released
        }
        try {
          controller.close();
        } catch {
          // controller already closed or errored
        }
      }
    },
    cancel() {
      aborted = true;
      try {
        reader?.cancel().catch(() => {});
        reader?.releaseLock();
      } catch {
        // stream already closed
      }
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
