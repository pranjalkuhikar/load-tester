import crypto from "node:crypto";
import { guard, fail } from "@/lib/guard";
import { live, saveRun, getAllowedHosts } from "@/lib/store";
import { Run, normalize } from "@/engine/engine";

export const dynamic = "force-dynamic";

// Start a run
export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    if (live.active) return Response.json({ error: "A test is already running. Stop it first." }, { status: 409 });
    const cfg = normalize(await req.json().catch(() => ({})), { allowedHosts: getAllowedHosts() });
    const id = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(2).toString("hex");
    const run = new Run(id, cfg);
    live.active = run;
    live.runs.set(id, run);
    if (live.runs.size > 5) live.runs.delete(live.runs.keys().next().value);
    run.on("end", () => { saveRun(run); live.active = null; });
    run.start().catch((e) => { console.error(e); live.active = null; });
    return Response.json({ id }, { status: 201 });
  } catch (e) { return fail(e); }
}
