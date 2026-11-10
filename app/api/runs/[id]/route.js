import { guard } from "@/lib/guard";
import { live, loadRun, deleteRun } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await params;
  const run = live.runs.get(id);
  if (run && run === live.active) return Response.json({ ...run.snapshot(), cfg: run.cfg });
  const r = (run && run.result) || loadRun(id);
  return r ? Response.json(r) : Response.json({ error: "Run not found" }, { status: 404 });
}

export async function DELETE(req, { params }) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await params;
  if (live.active && live.active.id === id) return Response.json({ error: "Stop the run first" }, { status: 409 });
  deleteRun(id);
  return Response.json({ ok: true });
}
