// Orchestrates a load run: splits work across worker threads, merges their delta stats,
// builds a per-second timeline, handles phases (single run or step test), and emits snapshots.
const { Worker } = require("node:worker_threads");
const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const H = require("./hist");
const { analyze } = require("./analyze");

const LIMITS = { maxTotal: 10_000_000, maxConcurrency: 5000, maxDurationSec: 3600, maxSteps: 12, maxThreads: 16 };

// ---------- config ----------
function isLoopbackHost(h) {
  h = String(h || "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "host.docker.internal";
}

function normalize(input) {
  const err = (m) => { const e = new Error(m); e.status = 400; throw e; };
  const num = (v, def, min, max, name) => {
    if (v === undefined || v === null || v === "") return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) err(`${name} must be between ${min} and ${max}`);
    return n;
  };
  let base;
  try { base = new URL(String(input.base || "")); } catch { err("Target base URL is invalid (example: http://localhost:3000)"); }
  if (!/^https?:$/.test(base.protocol)) err("Only http:// and https:// targets are supported");

  const raw = Array.isArray(input.endpoints) && input.endpoints.length ? input.endpoints : [{ method: "GET", path: "/" }];
  const endpoints = raw.slice(0, 200).map((e, i) => {
    const method = String(e.method || "GET").toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) err(`Endpoint ${i + 1}: unsupported method ${method}`);
    const p = String(e.path || "/");
    let url;
    if (/^https?:\/\//i.test(p)) url = p;
    else url = base.origin + (base.pathname.replace(/\/$/, "")) + (p.startsWith("/") ? p : "/" + p);
    {
      // placeholders are replaced with "x" so a templated host can't dodge the local-only check
      let u;
      try { u = new URL(url.replace(/\{\{[^}]*\}\}/g, "x")); } catch { err(`Endpoint ${i + 1}: invalid URL`); }
      if (!process.env.ALLOW_REMOTE && !isLoopbackHost(u.hostname))
        err(`Blocked: ${u.hostname} is not a local address. This tool only targets localhost by default (start with ALLOW_REMOTE=1 to override — only for systems you own).`);
    }
    const headers = {};
    for (const [k, v] of Object.entries(e.headers || {})) if (k && typeof v === "string") headers[k.toLowerCase()] = v;
    let body = e.body === undefined || e.body === null || e.body === "" ? null : typeof e.body === "string" ? e.body : JSON.stringify(e.body);
    if (body && !headers["content-type"]) headers["content-type"] = "application/json";
    return { name: `${method} ${p}`, method, url, headers, body, weight: num(e.weight, 1, 0, 1000, "weight") };
  });
  if (!endpoints.some((e) => e.weight > 0)) err("At least one endpoint needs weight > 0");

  const mode = ["requests", "duration", "steps"].includes(input.mode) ? input.mode : "requests";
  const cpus = os.cpus().length;
  const cfg = {
    name: String(input.name || "").slice(0, 80),
    base: base.origin,
    endpoints,
    mode,
    total: Math.floor(num(input.total, 1000, 1, LIMITS.maxTotal, "total requests")),
    durationSec: num(input.durationSec, 30, 1, LIMITS.maxDurationSec, "duration"),
    concurrency: Math.floor(num(input.concurrency, 50, 1, LIMITS.maxConcurrency, "concurrency")),
    rps: num(input.rps, 0, 0, 5_000_000, "rate limit"),
    rampSec: num(input.rampSec, 0, 0, 600, "ramp-up"),
    timeoutMs: Math.floor(num(input.timeoutMs, 10000, 100, 120000, "timeout")),
    thinkMs: Math.floor(num(input.thinkMs, 0, 0, 60000, "think time")),
    keepAlive: input.keepAlive !== false,
    threads: Math.floor(num(input.threads, 0, 0, LIMITS.maxThreads, "threads")) || Math.max(1, Math.min(4, Math.floor(cpus / 2))),
    steps: { levels: [], secondsPerStep: 15 },
    slo: { p95Ms: num(input.slo && input.slo.p95Ms, 500, 1, 600000, "SLO p95"), errorPct: num(input.slo && input.slo.errorPct, 1, 0, 100, "SLO error %") },
  };
  if (mode === "steps") {
    let levels = input.steps && Array.isArray(input.steps.levels) ? input.steps.levels : [10, 25, 50, 100, 200, 400];
    levels = levels.map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= LIMITS.maxConcurrency).map(Math.floor).slice(0, LIMITS.maxSteps);
    if (!levels.length) err("Step test needs at least one concurrency level");
    cfg.steps = { levels, secondsPerStep: num(input.steps && input.steps.secondsPerStep, 15, 2, 600, "seconds per step") };
  }
  return cfg;
}

function buildPhases(cfg) {
  if (cfg.mode === "steps")
  {
    // users join gradually inside each step (like real traffic) instead of all opening connections in the same instant
    const sec = cfg.steps.secondsPerStep;
    const ramp = cfg.rampSec > 0 ? Math.min(cfg.rampSec, sec * 0.8) : Math.min(3, sec * 0.2);
    return cfg.steps.levels.map((c) => ({ label: `${c} users`, concurrency: c, durationMs: sec * 1000, rampMs: ramp * 1000 }));
  }
  if (cfg.mode === "duration")
    return [{ label: "run", concurrency: cfg.concurrency, durationMs: cfg.durationSec * 1000, rampMs: cfg.rampSec * 1000 }];
  return [{ label: "run", concurrency: cfg.concurrency, total: cfg.total, rampMs: cfg.rampSec * 1000 }];
}

// ---------- aggregates ----------
function newAgg(nEps) {
  return {
    sent: 0, done: 0, errors: 0, bytes: 0, sumMs: 0, hist: H.newHist(), status: {}, errTypes: {},
    eps: Array.from({ length: nEps }, () => ({ done: 0, errors: 0, bytes: 0, sumMs: 0, hist: H.newHist(), status: {} })),
  };
}
function addObj(into, from) { for (const k in from) into[k] = (into[k] || 0) + from[k]; }
function mergeInto(a, d) {
  a.sent += d.sent; a.done += d.done; a.errors += d.errors; a.bytes += d.bytes; a.sumMs += d.sumMs;
  H.addHist(a.hist, d.hist); addObj(a.status, d.status); addObj(a.errTypes, d.errTypes);
  d.eps.forEach((e, i) => {
    const t = a.eps[i];
    t.done += e.done; t.errors += e.errors; t.bytes += e.bytes; t.sumMs += e.sumMs;
    H.addHist(t.hist, e.hist); addObj(t.status, e.status);
  });
}
function pctls(h, total) {
  return { p50: H.percentile(h, 50, total), p90: H.percentile(h, 90, total), p95: H.percentile(h, 95, total), p99: H.percentile(h, 99, total) };
}

// ---------- run ----------
class Run extends EventEmitter {
  constructor(id, cfg) {
    super();
    this.id = id;
    this.cfg = cfg;
    this.phasesCfg = buildPhases(cfg);
    this.state = "queued"; // queued | running | stopping | done | stopped | failed
    this.agg = newAgg(cfg.endpoints.length);
    this.phaseResults = [];
    this.phaseIdx = -1;
    this.timeline = [];
    this.sec = null; // current open second bucket
    this.samples = {};
    this.gen = { elP99Max: 0, elMax: 0, threads: 0 };
    this.recent = []; // [{t, done}] for live RPS
    this.peakRps = 0;
    this.workers = new Set();
    this.error = null;
    this.startedAt = null;
    this.endedAt = null;
    this.result = null;
  }

  get fixedTotal() { return this.cfg.mode === "requests" ? this.cfg.total : null; }
  get elapsed() { return ((this.endedAt || Date.now()) - this.startedAt) / 1000; }

  async start() {
    this.state = "running";
    this.startedAt = Date.now();
    this.t0 = this.startedAt;
    this.snapTimer = setInterval(() => this.emit("snapshot", this.snapshot()), 500);
    try {
      for (let i = 0; i < this.phasesCfg.length && !this.stopping; i++) {
        this.phaseIdx = i;
        await this.runPhase(this.phasesCfg[i]);
      }
      this.state = this.stopping ? "stopped" : this.error ? "failed" : "done";
    } catch (e) {
      this.error = e.message;
      this.state = "failed";
    }
    clearInterval(this.snapTimer);
    this.endedAt = Date.now();
    this.closeSecond(true);
    this.result = this.buildResult();
    this.emit("snapshot", this.snapshot());
    this.emit("end", this.result);
  }

  stop() {
    if (this.state !== "running") return;
    this.stopping = true;
    this.state = "stopping";
    for (const w of this.workers) w.postMessage({ type: "stop" });
  }

  runPhase(p) {
    return new Promise((resolve) => {
      const W = Math.max(1, Math.min(this.cfg.threads, p.concurrency));
      this.gen.threads = Math.max(this.gen.threads, W);
      const phaseAgg = newAgg(this.cfg.endpoints.length);
      const phaseStart = Date.now();
      this.cur = { agg: phaseAgg, p, W };
      let alive = W;
      const finish = () => {
        if (--alive > 0) return;
        const secs = Math.max(0.001, (Date.now() - phaseStart) / 1000);
        const pc = pctls(phaseAgg.hist, phaseAgg.done);
        this.phaseResults.push({
          label: p.label, concurrency: p.concurrency, seconds: +secs.toFixed(2), done: phaseAgg.done, errors: phaseAgg.errors,
          errorPct: phaseAgg.done ? +((phaseAgg.errors / phaseAgg.done) * 100).toFixed(3) : 0,
          rps: +(phaseAgg.done / secs).toFixed(1), avg: phaseAgg.done ? phaseAgg.sumMs / phaseAgg.done : 0, ...pc,
        });
        resolve();
      };
      const cBase = Math.floor(p.concurrency / W), cExtra = p.concurrency % W;
      const tBase = p.total ? Math.floor(p.total / W) : 0, tExtra = p.total ? p.total % W : 0;
      for (let i = 0; i < W; i++) {
        const concurrency = cBase + (i < cExtra ? 1 : 0);
        const total = p.total ? tBase + (i < tExtra ? 1 : 0) : null;
        if (concurrency < 1 || (p.total && total < 1)) { alive--; continue; }
        const wcfg = {
          id: i, concurrency, total, durationMs: p.durationMs || 0, rampMs: p.rampMs || 0,
          rps: this.cfg.rps ? this.cfg.rps / W : 0, timeoutMs: this.cfg.timeoutMs, thinkMs: this.cfg.thinkMs,
          keepAlive: this.cfg.keepAlive, endpoints: this.cfg.endpoints,
        };
        const w = new Worker(path.join(process.cwd(), "engine", "worker.js"), { workerData: wcfg });
        this.workers.add(w);
        let ended = false;
        const end = () => { if (ended) return; ended = true; this.workers.delete(w); finish(); };
        w.on("message", (m) => {
          if (m.type === "tick") this.onTick(m, phaseAgg);
          else if (m.type === "done") end();
        });
        w.on("error", (e) => { this.error = `worker crashed: ${e.message}`; this.stopping = true; end(); });
        w.on("exit", end);
      }
      if (alive <= 0) resolve();
    });
  }

  onTick(m, phaseAgg) {
    const d = m.d;
    mergeInto(this.agg, d);
    mergeInto(phaseAgg, d);
    this.gen.elP99Max = Math.max(this.gen.elP99Max, m.elP99);
    this.gen.elMax = Math.max(this.gen.elMax, m.elMax);
    for (const s of m.samples) if (!this.samples[s.ep]) this.samples[s.ep] = s;
    const now = Date.now();
    this.recent.push({ t: now, done: d.done });
    while (this.recent.length && now - this.recent[0].t > 2500) this.recent.shift();
    // per-second bucket
    const sec = Math.floor((now - this.t0) / 1000);
    if (!this.sec || this.sec.t !== sec) {
      this.closeSecond();
      this.sec = { t: sec, done: 0, errors: 0, bytes: 0, sumMs: 0, hist: H.newHist(), inflight: 0, conc: this.cur ? this.cur.p.concurrency : 0 };
    }
    const s = this.sec;
    s.done += d.done; s.errors += d.errors; s.bytes += d.bytes; s.sumMs += d.sumMs; H.addHist(s.hist, d.hist);
    s.inflight = Math.max(s.inflight, m.inflight);
  }

  closeSecond(final) {
    const s = this.sec;
    if (!s) return;
    this.sec = null;
    if (!s.done) { this.timeline.push({ t: s.t, rps: 0, errors: s.errors, p50: 0, p95: 0, p99: 0, avg: 0, conc: s.conc }); return; }
    const pc = pctls(s.hist, s.done);
    this.timeline.push({ t: s.t, rps: s.done, errors: s.errors, bytes: s.bytes, p50: pc.p50, p95: pc.p95, p99: pc.p99, avg: s.sumMs / s.done, conc: s.conc });
    if (s.done > this.peakRps && !final) this.peakRps = s.done;
  }

  timelineView(max = 600) {
    const tl = this.timeline;
    if (tl.length <= max) return tl;
    const f = Math.ceil(tl.length / max), out = [];
    for (let i = 0; i < tl.length; i += f) {
      const g = tl.slice(i, i + f);
      out.push({
        t: g[0].t, rps: g.reduce((a, x) => a + x.rps, 0) / g.length, errors: g.reduce((a, x) => a + x.errors, 0),
        p50: Math.max(...g.map((x) => x.p50)), p95: Math.max(...g.map((x) => x.p95)), p99: Math.max(...g.map((x) => x.p99)),
        avg: g.reduce((a, x) => a + x.avg, 0) / g.length, conc: g[g.length - 1].conc,
      });
    }
    return out;
  }

  liveRps() {
    if (this.recent.length < 2) return 0;
    const span = (this.recent[this.recent.length - 1].t - this.recent[0].t) / 1000;
    const sum = this.recent.slice(1).reduce((a, x) => a + x.done, 0);
    return span > 0 ? sum / span : 0;
  }

  totals() {
    const a = this.agg;
    const el = Math.max(0.001, this.elapsed);
    return {
      sent: a.sent, done: a.done, errors: a.errors, errorPct: a.done ? (a.errors / a.done) * 100 : 0,
      bytes: a.bytes, avgRps: a.done / el, avg: a.done ? a.sumMs / a.done : 0,
      min: H.minMs(a.hist), max: H.maxMs(a.hist), ...pctls(a.hist, a.done), status: a.status, errTypes: a.errTypes,
    };
  }

  epSummaries() {
    const el = Math.max(0.001, this.elapsed);
    return this.agg.eps.map((e, i) => ({
      name: this.cfg.endpoints[i].name, done: e.done, errors: e.errors, errorPct: e.done ? (e.errors / e.done) * 100 : 0,
      rps: e.done / el, avg: e.done ? e.sumMs / e.done : 0, avgBytes: e.done ? e.bytes / e.done : 0, ...pctls(e.hist, e.done), status: e.status,
    }));
  }

  snapshot() {
    const t = this.totals();
    const rps = this.state === "done" || this.state === "stopped" || this.state === "failed" ? t.avgRps : this.liveRps();
    const total = this.fixedTotal;
    let eta = null;
    if (this.state === "running") {
      if (total && rps > 0) eta = Math.max(0, (total - t.done) / rps);
      else if (this.cfg.mode !== "requests") {
        const plan = this.phasesCfg.reduce((a, p) => a + (p.durationMs || 0), 0) / 1000;
        eta = Math.max(0, plan - this.elapsed);
      }
    }
    return {
      id: this.id, state: this.state, error: this.error, elapsed: this.elapsed, eta, total, rps, peakRps: this.peakRps,
      phase: { index: Math.max(0, this.phaseIdx), count: this.phasesCfg.length, label: this.phasesCfg[Math.max(0, this.phaseIdx)]?.label, concurrency: this.phasesCfg[Math.max(0, this.phaseIdx)]?.concurrency },
      totals: t, eps: this.epSummaries(), timeline: this.timelineView(), bars: H.toBars(this.agg.hist), phases: this.phaseResults,
      gen: this.gen,
    };
  }

  buildResult() {
    const snap = this.snapshot();
    const samples = {};
    for (const [i, s] of Object.entries(this.samples)) {
      const h = s.headers || {};
      samples[i] = { status: s.status, ms: s.ms, headers: Object.fromEntries(["x-powered-by", "server", "content-encoding", "content-type", "content-length", "cache-control"].filter((k) => h[k]).map((k) => [k, String(h[k])])) };
    }
    const full = {
      ...snap, cfg: this.cfg, startedAt: this.startedAt, endedAt: this.endedAt, samples,
      system: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, node: process.version, platform: `${os.platform()} ${os.arch()}`, totalMemGB: +(os.totalmem() / 1e9).toFixed(1) },
      stoppedEarly: this.state === "stopped",
    };
    full.analysis = analyze(full);
    return full;
  }

  summary() {
    const r = this.result;
    const t = (r || this.snapshot()).totals;
    return {
      id: this.id, name: this.cfg.name, base: this.cfg.base, mode: this.cfg.mode, state: this.state,
      startedAt: this.startedAt, endedAt: this.endedAt, elapsed: this.elapsed,
      concurrency: this.cfg.mode === "steps" ? Math.max(...this.cfg.steps.levels) : this.cfg.concurrency, endpoints: this.cfg.endpoints.length,
      done: t.done, errors: t.errors, errorPct: t.errorPct, rps: t.avgRps, p50: t.p50, p95: t.p95, p99: t.p99,
      verdict: r && r.analysis ? r.analysis.verdict : null,
    };
  }
}

module.exports = { Run, normalize, isLoopbackHost, LIMITS };
