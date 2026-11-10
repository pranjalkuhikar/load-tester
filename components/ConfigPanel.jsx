"use client";
import { useState } from "react";
import { short } from "./format";

export const DEFAULT_CFG = {
  name: "",
  base: "http://localhost:3000",
  endpoints: [{ id: 1, method: "GET", path: "/api/health", weight: 1, headers: "", body: "", open: false }],
  mode: "requests",
  total: 1000,
  durationSec: 30,
  concurrency: 50,
  stepLevels: "10, 25, 50, 100, 200, 400",
  stepSeconds: 15,
  rps: 0,
  rampSec: 0,
  timeoutMs: 10000,
  keepAlive: true,
  threads: 0,
  sloP95: 500,
  sloErr: 1,
};

const TARGETS = [
  { label: "Next.js :3000", url: "http://localhost:3000" },
  { label: "Node :4000", url: "http://localhost:4000" },
  { label: "Demo :4100", url: "http://localhost:4100" },
];
const COUNTS = [500, 1000, 10000, 100000, 1000000];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function toPayload(c) {
  const parseHeaders = (t) => Object.fromEntries(String(t || "").split("\n").map((l) => l.split(/:(.*)/s)).filter((p) => p[0]?.trim() && p[1] !== undefined).map((p) => [p[0].trim(), p[1].trim()]));
  return {
    name: c.name, base: c.base.trim(), mode: c.mode, total: +c.total, durationSec: +c.durationSec, concurrency: +c.concurrency,
    rps: +c.rps, rampSec: +c.rampSec, timeoutMs: +c.timeoutMs, keepAlive: c.keepAlive, threads: +c.threads,
    steps: { levels: String(c.stepLevels).split(/[,\s]+/).filter(Boolean).map(Number), secondsPerStep: +c.stepSeconds },
    slo: { p95Ms: +c.sloP95, errorPct: +c.sloErr },
    endpoints: c.endpoints.map((e) => ({ method: e.method, path: e.path, weight: +e.weight, headers: parseHeaders(e.headers), body: e.body })),
  };
}

function Field({ label, hint, children }) {
  return (<label className="field"><span>{label}{hint && <em>{hint}</em>}</span>{children}</label>);
}

const isLoopback = (h) => /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$/i.test(h) || h.toLowerCase().endsWith(".localhost");
function hostOf(base) { try { return new URL(base).hostname.toLowerCase(); } catch { return ""; } }

export default function ConfigPanel({ cfg, setCfg, running, onStart, onStop, siblings, allowedHosts = [], onAllow, onRemoveHost }) {
  const host = hostOf(cfg.base);
  const external = !!host && !isLoopback(host);
  const approved = external && allowedHosts.includes(host);
  const [owns, setOwns] = useState(false);
  const [probe, setProbe] = useState(null);
  const [scanDir, setScanDir] = useState("");
  const [scan, setScan] = useState(null);
  const [picked, setPicked] = useState({});
  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const setEp = (id, k, v) => setCfg((c) => ({ ...c, endpoints: c.endpoints.map((e) => (e.id === id ? { ...e, [k]: v } : e)) }));
  const nextId = () => Math.max(0, ...cfg.endpoints.map((e) => e.id)) + 1;

  async function doProbe() {
    setProbe({ loading: true });
    const first = cfg.endpoints[0]?.path || "/";
    const url = /^https?:/.test(first) ? first : cfg.base.replace(/\/$/, "") + (first.startsWith("/") ? first : "/" + first);
    try { setProbe(await (await fetch("/api/probe?url=" + encodeURIComponent(url.replace(/\{\{[^}]*\}\}/g, "1")))).json()); }
    catch { setProbe({ ok: false, error: "Could not reach LoadLab server" }); }
  }
  async function doScan(dir) {
    const d = dir ?? scanDir;
    setScanDir(d); setScan({ loading: true });
    try {
      const r = await (await fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir: d }) })).json();
      setScan(r);
      setPicked(Object.fromEntries((r.routes || []).map((x) => [x.method + " " + x.path, !/metrics|health/.test(x.path)])));
    } catch { setScan({ error: "Scan failed" }); }
  }
  function addScanned() {
    const chosen = scan.routes.filter((r) => picked[r.method + " " + r.path]);
    if (!chosen.length) return;
    const defaults = { POST: '{"title":"load test {{uuid}}","completed":false}', PUT: '{"title":"updated {{rand:6}}"}', PATCH: '{"completed":true}' };
    setCfg((c) => {
      let id = Math.max(0, ...c.endpoints.map((e) => e.id));
      const keep = c.endpoints.filter((e) => !(e.path === "/api/health" && e.weight === 1 && c.endpoints.length === 1));
      return { ...c, endpoints: [...keep, ...chosen.map((r) => ({ id: ++id, method: r.method, path: r.path, weight: r.method === "GET" ? 3 : 1, headers: "", body: defaults[r.method] || "", open: !!defaults[r.method] }))] };
    });
    setScan(null);
  }

  const totalW = cfg.endpoints.reduce((a, e) => a + (+e.weight || 0), 0) || 1;

  return (
    <aside className="config">
      <section className="card">
        <h3><span className="n">1</span> Target</h3>
        <Field label="Base URL">
          <input value={cfg.base} onChange={(e) => set("base", e.target.value)} placeholder="http://localhost:3000" spellCheck={false} disabled={running} />
        </Field>
        <div className="chips">
          {TARGETS.map((t) => (<button key={t.url} className={"chip" + (cfg.base === t.url ? " on" : "")} onClick={() => set("base", t.url)} disabled={running}>{t.label}</button>))}
          <button className="chip ghost" onClick={doProbe} disabled={running}>⚡ Test connection</button>
        </div>
        {external && !approved && (
          <div className="remote warn">
            <b>🌐 External site: {host}</b>
            <p>LoadLab only tests <b>localhost</b> by default. Load-testing a site you don’t own can be illegal, and even on your own hosted site (Vercel, Netlify…) heavy traffic can use up quotas or get you rate-limited or blocked.</p>
            <label className="own"><input type="checkbox" checked={owns} onChange={(e) => setOwns(e.target.checked)} /> I own <b>{host}</b> (or have permission to load-test it)</label>
            <button className="btn sm primary" disabled={!owns || running} onClick={() => { onAllow(host); setOwns(false); }}>Allow this site</button>
          </div>
        )}
        {approved && (
          <div className="remote ok">
            <b>🌐 {host} is approved</b>
            <p>External limits apply: up to <b>100 users</b>, <b>100,000 requests</b> or <b>5 minutes</b> per test. Results include real network latency.</p>
            <button className="chip ghost" onClick={() => onRemoveHost(host)} disabled={running}>Remove approval</button>
          </div>
        )}
        {probe && (
          <div className={"probe " + (probe.loading ? "" : probe.ok ? "ok" : "bad")}>
            {probe.loading ? "Checking…" : probe.ok ? `✓ ${probe.status} in ${probe.ms.toFixed(0)} ms${probe.server ? " · " + probe.server : ""}` : `✕ ${probe.error}`}
          </div>
        )}
      </section>

      <section className="card">
        <h3><span className="n">2</span> Endpoints <small>{cfg.endpoints.length}</small></h3>
        <details className="scan" open={!!scan}>
          <summary>🔍 Auto-detect from a project folder</summary>
          {(siblings || []).length > 0 && (
            <div className="chips">{siblings.map((s) => (<button key={s.dir} className="chip" onClick={() => doScan(s.dir)} disabled={running}>{s.name}</button>))}</div>
          )}
          <div className="row">
            <input value={scanDir} onChange={(e) => setScanDir(e.target.value)} placeholder="/path/to/your/project" spellCheck={false} />
            <button className="btn sm" onClick={() => doScan()} disabled={running || !scanDir}>Scan</button>
          </div>
          {scan?.loading && <p className="muted">Scanning…</p>}
          {scan?.error && <p className="err">{scan.error}</p>}
          {scan?.routes && (
            <>
              <p className="muted">{scan.count} routes found (Next.js & Express). Untick what you don’t want.</p>
              <div className="routes">
                {scan.routes.map((r) => {
                  const k = r.method + " " + r.path;
                  return (<label key={k} title={r.note || r.file}><input type="checkbox" checked={!!picked[k]} onChange={(e) => setPicked({ ...picked, [k]: e.target.checked })} /><b className={"m " + r.method}>{r.method}</b><code>{r.path}</code><em>{r.source}</em></label>);
                })}
              </div>
              <button className="btn sm primary" onClick={addScanned}>Add selected</button>
            </>
          )}
        </details>

        {cfg.endpoints.map((e) => (
          <div className="ep" key={e.id}>
            <div className="row">
              <select className={"m " + e.method} value={e.method} onChange={(x) => setEp(e.id, "method", x.target.value)} disabled={running}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select>
              <input className="grow" value={e.path} onChange={(x) => setEp(e.id, "path", x.target.value)} placeholder="/api/..." spellCheck={false} disabled={running} />
              <input className="w" type="number" min="0" value={e.weight} onChange={(x) => setEp(e.id, "weight", x.target.value)} title="Traffic weight" disabled={running} />
              <button className="icon" title="Headers / body" onClick={() => setEp(e.id, "open", !e.open)}>{e.open ? "▾" : "▸"}</button>
              <button className="icon del" title="Remove" onClick={() => setCfg((c) => ({ ...c, endpoints: c.endpoints.filter((z) => z.id !== e.id) }))} disabled={running || cfg.endpoints.length < 2}>×</button>
            </div>
            <div className="share"><i style={{ width: ((+e.weight || 0) / totalW) * 100 + "%" }} /><span>{(((+e.weight || 0) / totalW) * 100).toFixed(0)}% of traffic</span></div>
            {e.open && (
              <div className="more">
                <textarea rows={2} value={e.headers} onChange={(x) => setEp(e.id, "headers", x.target.value)} placeholder={"Authorization: Bearer …\nX-Custom: value"} spellCheck={false} />
                <textarea rows={3} value={e.body} onChange={(x) => setEp(e.id, "body", x.target.value)} placeholder={'JSON body, e.g. {"title":"{{uuid}}"}'} spellCheck={false} />
                <p className="muted">Placeholders: <code>{"{{uuid}}"}</code> <code>{"{{int:1000}}"}</code> <code>{"{{rand:8}}"}</code> <code>{"{{ts}}"}</code> <code>{"{{pick:a|b|c}}"}</code></p>
              </div>
            )}
          </div>
        ))}
        <button className="btn sm" onClick={() => setCfg((c) => ({ ...c, endpoints: [...c.endpoints, { id: nextId(), method: "GET", path: "/", weight: 1, headers: "", body: "", open: false }] }))} disabled={running}>+ Add endpoint</button>
      </section>

      <section className="card">
        <h3><span className="n">3</span> Test type</h3>
        <div className="tabs">
          {[["requests", "Fixed requests"], ["duration", "Duration"], ["steps", "Step test"]].map(([k, l]) => (
            <button key={k} className={cfg.mode === k ? "on" : ""} onClick={() => set("mode", k)} disabled={running}>{l}</button>
          ))}
        </div>
        {cfg.mode === "requests" && (
          <>
            <Field label="Total requests">
              <input type="number" min="1" max="10000000" value={cfg.total} onChange={(e) => set("total", e.target.value)} disabled={running} />
            </Field>
            <div className="chips">{COUNTS.map((n) => (<button key={n} className={"chip" + (+cfg.total === n ? " on" : "")} onClick={() => set("total", n)} disabled={running}>{short(n)}</button>))}</div>
          </>
        )}
        {cfg.mode === "duration" && (
          <Field label="Duration" hint="seconds"><input type="number" min="1" value={cfg.durationSec} onChange={(e) => set("durationSec", e.target.value)} disabled={running} /></Field>
        )}
        {cfg.mode === "steps" && (
          <>
            <p className="muted">Raises concurrent users level by level to find the point where your app starts to struggle.</p>
            <Field label="Concurrent users per step" hint="comma separated"><input value={cfg.stepLevels} onChange={(e) => set("stepLevels", e.target.value)} disabled={running} /></Field>
            <Field label="Seconds per step"><input type="number" min="2" value={cfg.stepSeconds} onChange={(e) => set("stepSeconds", e.target.value)} disabled={running} /></Field>
          </>
        )}
      </section>

      <section className="card">
        <h3><span className="n">4</span> Load & limits</h3>
        <div className="grid2">
          {cfg.mode !== "steps" && <Field label="Concurrency" hint="parallel users"><input type="number" min="1" max="5000" value={cfg.concurrency} onChange={(e) => set("concurrency", e.target.value)} disabled={running} /></Field>}
          <Field label="Rate limit" hint="req/s, 0 = max"><input type="number" min="0" value={cfg.rps} onChange={(e) => set("rps", e.target.value)} disabled={running} /></Field>
          <Field label="Ramp-up" hint={cfg.mode === "steps" ? "s per step, 0 = auto" : "seconds"}><input type="number" min="0" value={cfg.rampSec} onChange={(e) => set("rampSec", e.target.value)} disabled={running} /></Field>
          <Field label="Timeout" hint="ms"><input type="number" min="100" value={cfg.timeoutMs} onChange={(e) => set("timeoutMs", e.target.value)} disabled={running} /></Field>
          <Field label="Threads" hint="0 = auto"><input type="number" min="0" max="16" value={cfg.threads} onChange={(e) => set("threads", e.target.value)} disabled={running} /></Field>
          <Field label="Keep-alive"><select value={cfg.keepAlive ? "1" : "0"} onChange={(e) => set("keepAlive", e.target.value === "1")} disabled={running}><option value="1">On (reuse connections)</option><option value="0">Off (new TCP each time)</option></select></Field>
        </div>
        <div className="grid2">
          <Field label="SLO: p95 under" hint="ms"><input type="number" min="1" value={cfg.sloP95} onChange={(e) => set("sloP95", e.target.value)} disabled={running} /></Field>
          <Field label="SLO: errors under" hint="%"><input type="number" min="0" step="0.1" value={cfg.sloErr} onChange={(e) => set("sloErr", e.target.value)} disabled={running} /></Field>
        </div>
      </section>

      <div className="startbar">
        <input className="name" value={cfg.name} onChange={(e) => set("name", e.target.value)} placeholder="Name this run (optional)" disabled={running} />
        {running ? (<button className="btn stop" onClick={onStop}>■ Stop test</button>) : (<button className="btn go" onClick={onStart}>▶ Start test</button>)}
      </div>
    </aside>
  );
}
