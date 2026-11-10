import { guard, fail } from "@/lib/guard";
import { scanProject } from "@/engine/scan";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => ({}));
    return Response.json(scanProject(String(body.dir || "")));
  } catch (e) { return fail(e); }
}
