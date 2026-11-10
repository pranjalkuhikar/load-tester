import { guard } from "@/lib/guard";
import { live } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req, { params }) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await params;
  if (!live.active || live.active.id !== id) return Response.json({ error: "Not running" }, { status: 404 });
  live.active.stop();
  return Response.json({ ok: true });
}
