"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ConfigPanel, { DEFAULT_CFG, toPayload } from "./ConfigPanel";
import Results from "./Results";
import History from "./History";

const KEY = "loadlab.cfg.v2";
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
};

// turn a stored run's config back into editable form state
function cfgFromRun(c) {
  return {
    ...DEFAULT_CFG, name: c.name || "", base: c.base, mode: c.mode, total: c.total, durationSec: c.durationSec, concurrency: c.concurrency,
    rps: c.rps, rampSec: c.rampSec, timeoutMs: c.timeoutMs, keepAlive: c.keepAlive, threads: c.threads,
    stepLevels: (c.steps?.levels || []).join(", ") || DEFAULT_CFG.stepLevels, stepSeconds: c.steps?.secondsPerStep || 15, sloP95: c.slo.p95Ms, sloErr: c.slo.errorPct,
    endpoints: c.endpoints.map((e, i) => ({
      id: i + 1, method: e.method, path: e.name.slice(e.method.length + 1), weight: e.weight, open: false,
      headers: Object.entries(e.headers || {}).filter(([k]) => k !== "content-type").map(([k, v]) => `${k}: ${v}`).join("\n"), body: e.body || "",
    })),
  };
}

export default function Dashboard() {
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState(null); // live snapshot or final result
  const [runCfg, setRunCfg] = useState(null);
  const [runId, setRunId] = useState(null);
  const [history, setHistory] = useState([]);
  const [siblings, setSiblings] = useState([]);
  const [allowedHosts, setAllowedHosts] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [sys, setSys] = useState(null);
  const [error, setError] = useState(null);
  const es = useRef(null);
  const resultsRef = useRef(null);

  const recent = [...new Set(history.map((h) => h.base))];
  const running = !!view && (view.state === "running" || view.state === "stopping");

  const refresh = useCallback(async () => {
    try {
      const s = await api("/api/state");
      setHistory(s.history); setSiblings(s.siblings || []); setAllowedHosts(s.allowedHosts || []); setSys(s.system);
      return s;
    } catch (e) { setError(e.message); }
  }, []);

  // look for HTTP servers running on this machine (common dev ports)
  const rescan = useCallback(async () => {
    setScanning(true);
    try { setDiscovered((await api("/api/discover")).servers || []); } catch { setDiscovered([]); }
    setScanning(false);
  }, []);

  const attach = useCallback((id) => {
    es.current?.close();
    setRunId(id);
    const src = new EventSource(`/api/runs/${id}/events`);
    es.current = src;
    src.addEventListener("config", (e) => setRunCfg(JSON.parse(e.data)));
    src.addEventListener("snapshot", (e) => setView(JSON.parse(e.data)));
    src.addEventListener("end", (e) => {
      const r = JSON.parse(e.data);
      setView(r); setRunCfg(r.cfg);
      src.close(); es.current = null;
      refresh();
    });
  }, [refresh]);

  // restore saved form + attach to a run that is already in progress
  useEffect(() => {
    try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); if (s) setCfg({ ...DEFAULT_CFG, ...s }); } catch {}
    setReady(true);
    rescan();
    const want = new URLSearchParams(window.location.search).get("run"); // deep link: /?run=<id>
    refresh().then((s) => { if (s?.active) attach(s.active); else if (want) openRun(want); else if (s?.history?.[0]) openRun(s.history[0].id); });
    return () => es.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (ready) try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} }, [cfg, ready]);

  async function start() {
    setError(null);
    try {
      const { id } = await api("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toPayload(cfg)) });
      setView(null); setRunCfg(null);
      attach(id);
      setTimeout(() => resultsRef.current?.scrollTo({ top: 0, behavior: "smooth" }), 100);
    } catch (e) { setError(e.message); }
  }
  // external sites must be explicitly approved (the server enforces this too)
  async function allowHost(host) {
    try {
      const r = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ host, confirm: true }) });
      setAllowedHosts(r.hosts); setError(null);
    } catch (e) { setError(e.message); }
  }
  async function removeHost(host) {
    try { const r = await api("/api/hosts?host=" + encodeURIComponent(host), { method: "DELETE" }); setAllowedHosts(r.hosts); } catch (e) { setError(e.message); }
  }
  async function stop() { try { await api(`/api/runs/${runId}/stop`, { method: "POST" }); } catch (e) { setError(e.message); } }
  async function openRun(id) {
    try {
      es.current?.close();
      const r = await api(`/api/runs/${id}`);
      setRunId(id); setView(r); setRunCfg(r.cfg || null);
      if (r.state === "running") attach(id);
    } catch (e) { setError(e.message); }
  }
  async function reuse(id) { try { const r = await api(`/api/runs/${id}`); if (r.cfg) setCfg(cfgFromRun(r.cfg)); } catch (e) { setError(e.message); } }
  async function del(id) {
    try { await api(`/api/runs/${id}`, { method: "DELETE" }); if (id === runId) { setView(null); setRunId(null); } refresh(); } catch (e) { setError(e.message); }
  }

  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><span className="logo">◢◤</span><div><b>LoadLab</b><small>local load testing for your APIs</small></div></div>
        <div className="meta">
          {sys && <span>{sys.cpus} cores · Node {sys.node}</span>}
          <span className={"state " + (running ? "run" : "idle")}>{running ? (view.state === "stopping" ? "stopping…" : "● running") : "idle"}</span>
        </div>
      </header>

      {error && <div className="banner" onClick={() => setError(null)}>⚠ {error} <span>dismiss</span></div>}

      <main className="layout">
        <ConfigPanel cfg={cfg} setCfg={setCfg} running={running} onStart={start} onStop={stop} siblings={siblings} allowedHosts={allowedHosts} onAllow={allowHost} onRemoveHost={removeHost} discovered={discovered} scanning={scanning} onRescan={rescan} recent={recent} />
        <div className="right" ref={resultsRef}>
          {view ? (
            <Results v={view} cfg={runCfg} />
          ) : (
            <div className="hero card">
              <span className="eyebrow">Load testing, made simple</span>
              <h2>Know how much traffic your API can take, before your users find out.</h2>
              <p>Send anywhere from 500 to 1,000,000 requests to an app running on your machine and watch it live: requests per second, how long users wait, what fails and why.</p>
              <div className="tiles">
                <div><b>📡 Live metrics</b><span>Throughput, p50 / p95 / p99 latency and errors, updated twice a second.</span></div>
                <div><b>🎯 Find the limit</b><span>A step test raises users level by level and shows exactly where your app breaks.</span></div>
                <div><b>🧠 Clear verdicts</b><span>Pass or fail against your goals, with the reason and how to fix it.</span></div>
                <div><b>🔍 Zero setup</b><span>Detects running servers and the routes in your project automatically.</span></div>
              </div>
              <h4>Get started</h4>
              <ol>
                <li><b>Pick a target</b> from “Running on this machine”, or type a URL.</li>
                <li><b>Choose endpoints</b>. Auto-detect them from your project folder, or add your own.</li>
                <li><b>Pick a scenario</b>, such as Smoke test or Find the limit, and press <b>Start test</b>.</li>
              </ol>
            </div>
          )}
          <History items={history} current={runId} onOpen={openRun} onDelete={del} onReuse={reuse} />
        </div>
      </main>
    </div>
  );
}
