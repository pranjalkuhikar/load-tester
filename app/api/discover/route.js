import net from "node:net";
import http from "node:http";
import { guard } from "@/lib/guard";

export const dynamic = "force-dynamic";

// Common dev-server ports. We only look at this machine (localhost), nothing else.
const PORTS = [3000, 3001, 3002, 3003, 4000, 4100, 4200, 5000, 5173, 5174, 8000, 8001, 8080, 8081, 8888, 9000, 1337, 7000];

const isOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: "localhost", port, timeout: 300 });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("timeout", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(false));
});

// identify what is answering, from response headers only
const identify = (port) => new Promise((resolve) => {
  const req = http.get({ host: "localhost", port, path: "/", timeout: 1500 }, (res) => {
    res.resume();
    const powered = String(res.headers["x-powered-by"] || "");
    const server = String(res.headers.server || "");
    let name = "HTTP server";
    if (/next/i.test(powered)) name = "Next.js";
    else if (/express/i.test(powered)) name = "Express";
    else if (/php/i.test(powered)) name = "PHP";
    else if (/nginx/i.test(server)) name = "Nginx";
    else if (/uvicorn|gunicorn|werkzeug|python|django/i.test(server)) name = "Python";
    else if (/vite/i.test(server) || res.headers["vary"]?.includes("Origin")) name = "Dev server";
    else if (server) name = server.split("/")[0].slice(0, 18);
    resolve({ ok: !/airtunes|airplay/i.test(server), name, status: res.statusCode });
  });
  req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
  req.on("error", () => resolve({ ok: false }));
});

export async function GET(req) {
  const denied = guard(req);
  if (denied) return denied;
  const own = Number((req.headers.get("host") || "").split(":")[1]) || 0; // don't list LoadLab itself
  const open = (await Promise.all(PORTS.filter((p) => p !== own).map(async (p) => ((await isOpen(p)) ? p : null)))).filter(Boolean);
  const found = (await Promise.all(open.map(async (port) => ({ port, ...(await identify(port)) })))).filter((x) => x.ok);
  return Response.json({ servers: found.map(({ port, name, status }) => ({ port, name, status, url: `http://localhost:${port}` })) });
}
