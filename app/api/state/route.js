import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { guard } from "@/lib/guard";
import { live, listHistory, getAllowedHosts } from "@/lib/store";

export const dynamic = "force-dynamic";

// sibling project folders (those with a package.json) so the UI can offer one-click "scan" chips
function siblings() {
  const parent = path.dirname(process.cwd());
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== path.basename(process.cwd()) && fs.existsSync(path.join(/*turbopackIgnore: true*/ parent, d.name, "package.json")))
      .map((d) => ({ name: d.name, dir: path.join(/*turbopackIgnore: true*/ parent, d.name) }));
  } catch { return []; }
}

export async function GET(req) {
  const denied = guard(req);
  if (denied) return denied;
  return Response.json({
    active: live.active ? live.active.id : null,
    history: listHistory(),
    siblings: siblings(),
    allowedHosts: getAllowedHosts(),
    system: { cpus: os.cpus().length, node: process.version, platform: `${os.platform()} ${os.arch()}`, remoteAllowed: !!process.env.ALLOW_REMOTE },
  });
}
