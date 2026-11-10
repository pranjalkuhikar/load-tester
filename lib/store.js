// In-memory registry of live runs (survives dev hot-reload via globalThis) + JSON-file history.
import fs from "node:fs";
import path from "node:path";

const g = globalThis;
g.__loadlab ??= { active: null, runs: new Map() };
export const live = g.__loadlab;

const DATA = path.join(process.cwd(), "data", "runs");
fs.mkdirSync(DATA, { recursive: true });

export function listHistory() {
  const out = [];
  for (const f of fs.readdirSync(DATA)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")).summary); } catch {}
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export function saveRun(run) {
  try {
    fs.writeFileSync(path.join(DATA, run.id + ".json"), JSON.stringify({ summary: run.summary(), result: run.result }));
    const files = fs.readdirSync(DATA).filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(path.join(DATA, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const old of files.slice(100)) fs.unlinkSync(path.join(DATA, old.f));
  } catch (e) { console.error("[loadlab] could not save run:", e.message); }
}

export function loadRun(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DATA, id + ".json"), "utf8")).result; } catch { return null; }
}

export function deleteRun(id) {
  live.runs.delete(id);
  if (/^[\w-]+$/.test(id)) try { fs.unlinkSync(path.join(DATA, id + ".json")); } catch {}
}

// ---- external hosts the user has explicitly confirmed they own ----
const ALLOW_FILE = path.join(process.cwd(), "data", "allowed-hosts.json");
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function getAllowedHosts() {
  try { return JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8")).hosts || []; } catch { return []; }
}
export function addAllowedHost(raw) {
  const host = String(raw || "").trim().toLowerCase();
  if (!HOST_RE.test(host)) { const e = new Error("Enter a valid domain name, e.g. example.com"); e.status = 400; throw e; }
  const hosts = [...new Set([...getAllowedHosts(), host])];
  fs.writeFileSync(ALLOW_FILE, JSON.stringify({ hosts }, null, 2));
  return hosts;
}
export function removeAllowedHost(raw) {
  const host = String(raw || "").trim().toLowerCase();
  const hosts = getAllowedHosts().filter((h) => h !== host);
  fs.writeFileSync(ALLOW_FILE, JSON.stringify({ hosts }, null, 2));
  return hosts;
}
