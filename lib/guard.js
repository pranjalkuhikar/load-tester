// Only this dashboard (on a loopback host) may call the API — blocks DNS-rebinding and
// drive-by requests from other websites open in your browser.
const LOOP = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function guard(req) {
  const host = (req.headers.get("host") || "").toLowerCase();
  const origin = req.headers.get("origin");
  const hostname = host.replace(/:\d+$/, "");
  let ok = LOOP.has(hostname);
  if (ok && origin) {
    try { ok = new URL(origin).host.toLowerCase() === host; } catch { ok = false; }
  }
  return ok ? null : new Response("Forbidden", { status: 403 });
}
export const fail = (e) => Response.json({ error: e.message, code: e.code, host: e.host }, { status: e.status || 500 });
