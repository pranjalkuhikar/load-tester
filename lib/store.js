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
