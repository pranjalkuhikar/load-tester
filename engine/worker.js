// Load-generating worker thread. Runs `concurrency` async loops that fire HTTP requests
// as fast as responses come back (or at a paced rate), and ships delta stats every 250ms.
const { parentPort, workerData } = require("node:worker_threads");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const { N, bucket } = require("./hist");

const cfg = workerData;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopped = false;
parentPort.on("message", (m) => {
  if (m && m.type === "stop") stopped = true;
});

// ---------- endpoints ----------
const dyn = (s) => typeof s === "string" && s.includes("{{");
const eps = cfg.endpoints.map((e) => {
  const u = new URL(e.url);
  return {
    ...e,
    parsed: u,
    lib: u.protocol === "https:" ? https : http,
    dynUrl: dyn(e.url),
    dynBody: dyn(e.body),
    dynHeaders: Object.values(e.headers || {}).some(dyn),
  };
});
const cum = [];
{
  let s = 0;
  for (const e of eps) cum.push((s += Math.max(0, e.weight || 1)));
}
const totalWeight = cum[cum.length - 1] || 1;
const pick = () => {
  if (eps.length === 1) return 0;
  const r = Math.random() * totalWeight;
  for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i;
  return cum.length - 1;
};

// {{uuid}} {{int}} {{int:1000}} {{rand:8}} {{ts}} {{pick:a|b|c}}
function render(s) {
  return s.replace(/\{\{\s*([a-z]+)(?::([^}]*))?\s*\}\}/gi, (_, name, arg) => {
    switch (name.toLowerCase()) {
      case "uuid": return crypto.randomUUID();
      case "int": return String(Math.floor(Math.random() * (Number(arg) || 1e9)));
      case "rand": return crypto.randomBytes(Math.ceil((Number(arg) || 8) / 2)).toString("hex").slice(0, Number(arg) || 8);
      case "ts": return String(Date.now());
      case "pick": { const o = (arg || "").split("|"); return o[Math.floor(Math.random() * o.length)]; }
      default: return _;
    }
  });
}

// ---------- agents ----------
const agentOpts = { keepAlive: cfg.keepAlive, maxSockets: cfg.concurrency + 8, maxFreeSockets: cfg.concurrency + 8, timeout: 0 };
const agents = {
  "http:": new http.Agent(agentOpts),
  "https:": new https.Agent({ ...agentOpts, rejectUnauthorized: !cfg.insecureTls }),
};

// ---------- stats (delta since last flush) ----------
const mkDelta = () => ({
  sent: 0, done: 0, errors: 0, bytes: 0,
  hist: new Uint32Array(N), status: {}, errTypes: {},
  eps: eps.map(() => ({ done: 0, errors: 0, bytes: 0, hist: new Uint32Array(N), status: {}, sumMs: 0 })),
  sumMs: 0,
});
let d = mkDelta();
let inflight = 0;
const sampled = new Set();
const samples = [];
const elh = monitorEventLoopDelay({ resolution: 10 });
elh.enable();

function record(i, ms, status, err, bytes) {
  inflight--;
  d.done++;
  d.bytes += bytes;
  d.sumMs += ms;
  const b = bucket(ms);
  d.hist[b]++;
  const e = d.eps[i];
  e.done++; e.bytes += bytes; e.sumMs += ms; e.hist[b]++;
  const key = err ? "ERR" : String(status);
  d.status[key] = (d.status[key] || 0) + 1;
  e.status[key] = (e.status[key] || 0) + 1;
  if (err) {
    d.errors++; e.errors++;
    d.errTypes[err] = (d.errTypes[err] || 0) + 1;
  } else if (status >= 500) {
    d.errors++; e.errors++;
  }
}

function flush(final) {
  const msg = {
    type: "tick", w: cfg.id, inflight,
    elP99: elh.percentile(99) / 1e6, elMax: elh.max / 1e6,
    d, samples: samples.splice(0),
  };
  elh.reset();
  parentPort.postMessage(msg);
  d = mkDelta();
}

// ---------- one request ----------
function fire(i) {
  return new Promise((resolve) => {
    const ep = eps[i];
    d.sent++;
    inflight++;
    const t0 = performance.now();
    let finished = false;
    let timer;
    let req;
    const finish = (status, err, bytes) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      record(i, performance.now() - t0, status, err, bytes);
      resolve();
    };
    let u = ep.parsed;
    if (ep.dynUrl) u = new URL(render(ep.url));
    let headers = ep.headers;
    if (ep.dynHeaders) headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, render(v)]));
    let body = ep.body;
    if (body != null && body !== "") {
      if (ep.dynBody) body = render(body);
      headers = { ...headers, "content-length": Buffer.byteLength(body) };
    } else body = null;
    try {
      req = ep.lib.request(
        { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: ep.method, headers, agent: agents[u.protocol] },
        (res) => {
          let bytes = 0;
          if (!sampled.has(i)) {
            sampled.add(i);
            samples.push({ ep: i, status: res.statusCode, headers: res.headers, ms: performance.now() - t0 });
          }
          res.on("data", (c) => (bytes += c.length));
          res.on("end", () => finish(res.statusCode, null, bytes));
          res.on("error", (e) => finish(0, e.code || "RES_ERROR", bytes));
          res.on("aborted", () => finish(0, "ABORTED", bytes));
        }
      );
    } catch (e) {
      return finish(0, "BAD_REQUEST", 0);
    }
    timer = setTimeout(() => {
      finish(0, "TIMEOUT", 0);
      req.destroy();
    }, cfg.timeoutMs);
    req.on("error", (e) => finish(0, e.code || (e.message || "ERR").slice(0, 32), 0));
    if (body) req.write(body);
    req.end();
  });
}

// ---------- main ----------
let remaining = cfg.total; // null = duration mode
const deadline = cfg.durationMs ? Date.now() + cfg.durationMs : Infinity;
const interval = cfg.rps > 0 ? 1000 / cfg.rps : 0; // per-worker pacing
let nextSlot = performance.now();

async function loop(n) {
  if (cfg.rampMs) await sleep((cfg.rampMs * n) / cfg.concurrency);
  while (!stopped && Date.now() < deadline) {
    if (remaining !== null) {
      if (remaining <= 0) break;
      remaining--;
    }
    if (interval) {
      const now = performance.now();
      const slot = Math.max(now, nextSlot);
      nextSlot = slot + interval;
      if (slot > now) await sleep(slot - now);
      if (stopped || Date.now() >= deadline) break;
    }
    await fire(pick());
    if (cfg.thinkMs) await sleep(cfg.thinkMs);
  }
}

(async () => {
  const iv = setInterval(() => flush(false), 250);
  const loops = [];
  for (let n = 0; n < cfg.concurrency; n++) loops.push(loop(n));
  await Promise.all(loops);
  clearInterval(iv);
  flush(true);
  elh.disable();
  for (const a of Object.values(agents)) a.destroy();
  parentPort.postMessage({ type: "done", w: cfg.id });
})();
