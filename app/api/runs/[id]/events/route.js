import { guard } from "@/lib/guard";
import { live, loadRun } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Server-Sent Events: live snapshots every 500ms, then a final "end" event with the full analysed result.
export async function GET(req, { params }) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await params;
  const run = live.runs.get(id);
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event, data) => { if (!closed) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); };
      const close = () => { if (closed) return; closed = true; cleanup(); try { controller.close(); } catch {} };
      controller.enqueue(enc.encode("retry: 1000\n\n"));

      if (run && run === live.active) {
        const onSnap = (s) => send("snapshot", s);
        const onEnd = (r) => { send("end", r); close(); };
        run.on("snapshot", onSnap);
        run.once("end", onEnd);
        cleanup = () => { run.off("snapshot", onSnap); run.off("end", onEnd); };
        send("config", run.cfg);
        send("snapshot", run.snapshot());
        req.signal.addEventListener("abort", close);
      } else {
        const r = (run && run.result) || loadRun(id);
        if (r) send("end", r);
        close();
      }
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", connection: "keep-alive" } });
}
