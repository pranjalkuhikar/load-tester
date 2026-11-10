import http from "node:http";
import https from "node:https";
import { guard } from "@/lib/guard";
import { isLoopbackHost } from "@/engine/engine";

export const dynamic = "force-dynamic";

function probe(rawUrl) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(rawUrl); } catch { return resolve({ ok: false, error: "Invalid URL" }); }
    if (!/^https?:$/.test(u.protocol)) return resolve({ ok: false, error: "Only http(s) URLs" });
    if (!process.env.ALLOW_REMOTE && !isLoopbackHost(u.hostname)) return resolve({ ok: false, error: "Blocked: not a local address" });
    const lib = u.protocol === "https:" ? https : http;
    const t0 = process.hrtime.bigint();
    const req = lib.get(u, { timeout: 5000, rejectUnauthorized: false }, (r) => {
      let body = "";
      r.on("data", (c) => { if (body.length < 300) body += c; });
      r.on("end", () => resolve({ ok: true, status: r.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, server: r.headers["x-powered-by"] || r.headers.server || null, type: r.headers["content-type"] || null, snippet: body.slice(0, 200) }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Timed out after 5 s" }); });
    req.on("error", (e) => resolve({ ok: false, error: e.code === "ECONNREFUSED" ? "Connection refused — is the app running on that port?" : e.message }));
  });
}

export async function GET(req) {
  const denied = guard(req);
  if (denied) return denied;
  return Response.json(await probe(new URL(req.url).searchParams.get("url") || ""));
}
