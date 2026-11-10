// Detects API routes in a project folder: Next.js (app/**/route.*, pages/api/**) and Express-style (app.get('/x')).
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SKIP = new Set(["node_modules", ".next", ".git", "dist", "build", "out", "coverage", ".turbo", ".cache"]);
const CODE = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function walk(dir, files = [], depth = 0) {
  if (depth > 8 || files.length > 3000) return files;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") continue;
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), files, depth + 1); }
    else if (CODE.test(e.name)) files.push(path.join(dir, e.name));
  }
  return files;
}
const read = (f) => { try { const s = fs.statSync(f); return s.size > 600_000 ? "" : fs.readFileSync(f, "utf8"); } catch { return ""; } };
const sample = (seg) => (/^\[\.\.\./.test(seg) || /^\[/.test(seg) ? "1" : seg);

function scanProject(dirInput) {
  let dir = dirInput.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!dir) return { error: "Enter a project folder path" };
  dir = path.resolve(dir);
  let st;
  try { st = fs.statSync(dir); } catch { return { error: "Folder not found" }; }
  if (!st.isDirectory()) return { error: "Not a folder" };

  const found = new Map();
  const add = (method, p, source, file, note) => {
    p = ("/" + p.replace(/^\/+/, "")).replace(/\/+$/, "") || "/";
    const key = method + " " + p;
    if (!found.has(key)) found.set(key, { method, path: p, source, file: path.relative(dir, file), note: note || null });
  };

  for (const f of walk(dir)) {
    const rel = path.relative(dir, f).split(path.sep);
    const base = path.basename(f).replace(/\.[^.]+$/, "");
    const appIdx = rel.lastIndexOf("app");
    // Next.js app router: app/**/route.js
    if (base === "route" && appIdx >= 0) {
      const src = read(f);
      const segs = rel.slice(appIdx + 1, -1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
      const dynamic = segs.some((s) => s.startsWith("["));
      const p = segs.map(sample).join("/");
      const ms = METHODS.filter((m) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b|export\\s+(?:const|let|var)\\s+${m}\\b|export\\s*\\{[^}]*\\b${m}\\b`).test(src));
      for (const m of ms.length ? ms : ["GET"]) add(m, p, "Next.js", f, dynamic ? "dynamic segment replaced with 1 — adjust to a real id" : null);
      continue;
    }
    // Next.js pages router: pages/api/**
    const pagesIdx = rel.lastIndexOf("pages");
    if (pagesIdx >= 0 && rel[pagesIdx + 1] === "api") {
      const segs = [...rel.slice(pagesIdx + 1, -1), base === "index" ? "" : base].filter(Boolean);
      add("GET", segs.map(sample).join("/"), "Next.js (pages)", f, "methods unknown — defaulting to GET");
      continue;
    }
    // Express / Fastify / Koa-router style
    const src = read(f);
    if (!src || !/\b(app|router|server|fastify|api)\s*\.\s*(get|post|put|patch|delete)\s*\(/.test(src)) continue;
    const re = /\b(?:app|router|server|fastify|api)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(?:\[\s*)?(['"`])([^'"`]+)\2/g;
    let m;
    while ((m = re.exec(src))) {
      const p = m[3];
      if (!p.startsWith("/")) continue;
      const dyn = /[:*]/.test(p);
      add(m[1].toUpperCase(), p.replace(/:[A-Za-z_]\w*\??/g, "1").replace(/\*/g, "x"), "Express", f, dyn ? "path param replaced with 1" : null);
    }
  }
  const routes = [...found.values()].sort((a, b) => a.path.localeCompare(b.path) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method));
  return { dir, routes, count: routes.length };
}

module.exports = { scanProject };
