import { guard, fail } from "@/lib/guard";
import { addAllowedHost, removeAllowedHost } from "@/lib/store";

export const dynamic = "force-dynamic";

// Approve an external site the user owns. Requires an explicit confirmation flag from the UI.
export async function POST(req) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== true) return Response.json({ error: "Confirmation required: you must confirm you own this site." }, { status: 400 });
    return Response.json({ hosts: addAllowedHost(body.host) });
  } catch (e) { return fail(e); }
}

export async function DELETE(req) {
  const denied = guard(req);
  if (denied) return denied;
  return Response.json({ hosts: removeAllowedHost(new URL(req.url).searchParams.get("host")) });
}
