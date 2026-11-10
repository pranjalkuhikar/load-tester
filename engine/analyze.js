// Turns raw run results into a verdict + prioritised, actionable suggestions.
const fmt = (n, d = 0) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: d }) : (+n).toFixed(d));
const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(2) + " s" : n >= 10 ? n.toFixed(0) + " ms" : n.toFixed(1) + " ms");
const pct = (n) => (n < 0.01 ? n.toFixed(3) : n < 1 ? n.toFixed(2) : n.toFixed(1)) + "%";

function analyze(r) {
  const t = r.totals, cfg = r.cfg, tl = (r.timeline || []).length > 4 ? r.timeline.slice(0, -1) : r.timeline || [] /* last second is partial */, eps = r.eps || [], out = [];
  const add = (level, title, detail, fix) => out.push({ level, title, detail, fix: fix || null });
  const slo = cfg.slo;
  const users = cfg.mode === "steps" ? Math.max(...cfg.steps.levels) : cfg.concurrency;

  if (!t.done) {
    add("critical", "No requests completed", "The run ended before any response was recorded.", "Check the target URL, that the app is running, and the port number.");
    return { verdict: { status: "FAIL", headline: "No data", sloP95: false, sloErr: false }, insights: out, capacity: null };
  }

  // ---- errors ----
  const et = t.errTypes || {};
  const errTotal = Object.values(et).reduce((a, b) => a + b, 0);
  if (et.ECONNREFUSED) {
    add("critical", "Connection refused", `${fmt(et.ECONNREFUSED)} requests were refused — nothing is listening on that port, or the server crashed during the test.`,
      "Confirm the app is running (`lsof -iTCP:<port> -sTCP:LISTEN`). If it died mid-test, check its logs for an OOM / unhandled exception.");
  }
  if (et.TIMEOUT) {
    const p = (et.TIMEOUT / t.done) * 100;
    add(p > 5 ? "critical" : "warn", "Requests timing out", `${fmt(et.TIMEOUT)} requests (${pct(p)}) exceeded the ${cfg.timeoutMs} ms timeout. The server is accepting connections but can't answer in time — a sign of saturation or a blocked event loop.`,
      "Find the slow endpoint in the table below, then profile it (clinic.js / `node --inspect`). Check DB pool size and slow queries; move CPU-heavy work off the request path.");
  }
  const dropped = (et.ECONNRESET || 0) + (et.EPIPE || 0) + (et.ABORTED || 0) + (et.RES_ERROR || 0);
  if (dropped) {
    add("warn", "Connections dropped by the server", `${fmt(dropped)} requests had their connection reset/aborted mid-flight.`,
      "Usually keep-alive timeout mismatch, a proxy limit, or the process restarting. In Node set `server.keepAliveTimeout` above your proxy's idle timeout; check for crashes/restarts (PM2, Docker).");
  }
  if (et.EADDRNOTAVAIL || et.EMFILE || et.ENFILE) {
    add("warn", "Load generator ran out of sockets/ports", `The test machine itself hit an OS limit (${["EADDRNOTAVAIL", "EMFILE", "ENFILE"].filter((k) => et[k]).join(", ")}), so these failures aren't the server's fault.`,
      "Leave keep-alive ON, lower concurrency, or raise limits: `ulimit -n 65535` (and on macOS `sudo sysctl -w net.inet.ip.portrange.first=16384`).");
  }
  const other = Object.entries(et).filter(([k]) => !["ECONNREFUSED", "TIMEOUT", "ECONNRESET", "EPIPE", "ABORTED", "RES_ERROR", "EADDRNOTAVAIL", "EMFILE", "ENFILE"].includes(k));
  if (other.length) add("warn", "Other network errors", other.map(([k, v]) => `${k} ×${fmt(v)}`).join(", "), null);

  const st = t.status || {};
  const s5 = Object.entries(st).filter(([k]) => /^5/.test(k)).reduce((a, [, v]) => a + v, 0);
  if (s5) {
    const worst = eps.filter((e) => Object.keys(e.status).some((k) => /^5/.test(k))).sort((a, b) => b.errorPct - a.errorPct).slice(0, 3);
    add(s5 / t.done > 0.01 ? "critical" : "warn", "Server errors (5xx)",
      `${fmt(s5)} responses (${pct((s5 / t.done) * 100)}) were 5xx.${worst.length ? " Worst: " + worst.map((e) => `${e.name} (${pct(e.errorPct)})`).join(", ") + "." : ""}`,
      "Open the app logs for the test window (your Grafana/Loki at :3001 → filter level=error). Typical causes under load: exhausted DB connection pool, unhandled promise rejections, upstream timeouts, rate-limit misconfig.");
  }
  const cnt = (re) => Object.entries(st).filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
  if (st["429"] > 0) add("warn", "Rate limiting kicked in (429)", `${fmt(st["429"])} requests (${pct((st["429"] / t.done) * 100)}) were throttled. Your rate limiter works — but results above that point measure the limiter, not the app.`, "Raise or disable the limiter for load tests (e.g. env flag), or lower the request rate.");
  if (st["401"] || st["403"]) add("info", "Auth failures (401/403)", `${fmt((st["401"] || 0) + (st["403"] || 0))} requests were rejected for auth. They're fast, so they flatter latency.`, "Add an Authorization header to the endpoint (Headers field) so you test the real code path.");
  if (st["404"] / t.done > 0.05) add("info", "Many 404s", `${pct((st["404"] / t.done) * 100)} of responses were 404 — those paths probably don't exist, so you're not testing real work.`, "Check endpoint paths. Tip: use “Scan project” to detect real routes.");
  if (st["400"] / t.done > 0.05 || st["422"] / t.done > 0.05) add("info", "Many 400/422 validation errors", "Request bodies are being rejected, so the handler likely returns before doing real work.", "Fix the body JSON for those endpoints; use {{uuid}}, {{int}}, {{rand:8}} for unique values.");
  void cnt;

  // ---- latency shape ----
  // judge the tail per endpoint, so mixing a fast and a slow route isn't mistaken for jitter
  const liveEps = eps.filter((e) => e.done >= 50 && e.p50 > 0);
  const tailEp = (liveEps.length ? liveEps : [{ name: "all requests", p50: t.p50, p99: t.p99 }]).map((e) => ({ name: e.name, p50: e.p50, p99: e.p99, ratio: e.p99 / e.p50 })).sort((a, b) => b.ratio - a.ratio)[0];
  if (tailEp.ratio >= 8 && tailEp.p99 > 100) {
    add("warn", "Heavy latency tail", `${tailEp.name}: p99 is ${ms(tailEp.p99)} but the median is ${ms(tailEp.p50)} (${tailEp.ratio.toFixed(0)}× gap). Most users are fine; a slice gets a bad experience.`,
      "Suspects: GC pauses, a blocking sync call on the event loop, cold DB connections, lock contention, or periodic jobs. Take a CPU profile during the run and check event-loop lag.");
  }
  if (t.min > 0 && t.p50 > t.min * 4 && t.p50 > 40 && users >= 20) {
    add("warn", "Requests are queueing", `Median latency (${ms(t.p50)}) is ${(t.p50 / t.min).toFixed(0)}× the fastest response (${ms(t.min)}). With ${users} concurrent users the server is saturated: extra load only adds waiting time, not throughput.`,
      "Scale out (PM2 cluster / multiple instances behind Nginx), raise the DB pool (and make sure the DB can take it), cache hot reads, or add indexes. Re-run the Step test to find the concurrency where p95 starts climbing.");
  }

  // ---- trends ----
  if (tl.length >= 8) {
    const q = Math.floor(tl.length / 4);
    const first = tl.slice(1, 1 + q), last = tl.slice(-q);
    const avg = (a, k) => a.reduce((s, x) => s + x[k], 0) / Math.max(1, a.length);
    const p1 = avg(first, "p95"), p2 = avg(last, "p95");
    if (cfg.mode !== "steps" && p2 > p1 * 1.8 && p2 - p1 > 30) {
      add("warn", "Latency climbs during the test", `p95 grew from ~${ms(p1)} at the start to ~${ms(p2)} at the end. A healthy service stays flat.`,
        "Points to a leak or growing backlog: unbounded in-memory caches/arrays, DB table growth without index, connections not released, or logging overhead. Compare memory (RSS/heap) before and after.");
    }
    const r1 = avg(first, "rps"), r2 = avg(last, "rps");
    if (cfg.mode !== "steps" && !cfg.rps && r1 > 50 && r2 < r1 * 0.7) {
      add("warn", "Throughput decays over time", `Requests/sec fell from ~${fmt(r1)} to ~${fmt(r2)}.`, "Look for resource exhaustion (file descriptors, DB pool, memory pressure → GC thrash) or thermal throttling of the laptop.");
    }
  }

  // ---- warm-up / Next.js dev mode ----
  const nextish = Object.values(r.samples || {}).some((s) => /next/i.test((s.headers || {})["x-powered-by"] || ""));
  if (nextish && t.p50 > 25) {
    add("info", "Next.js detected — benchmark the production build", "Latency of a Next.js app in `next dev` is dominated by on-demand compilation and no caching; numbers are 3-10× worse than production.",
      "Run `next build && next start` (and set NODE_ENV=production), then re-test. Also cache with `revalidate`/`unstable_cache` for read-heavy routes.");
  }
  if (tl.length >= 5) {
    const warm = tl.slice(0, 2), rest = tl.slice(2);
    const wp = Math.max(...warm.map((x) => x.p95)), rp = rest.reduce((s, x) => s + x.p95, 0) / rest.length;
    if (wp > rp * 3 && wp > 150) add("info", "Slow warm-up", `The first seconds had p95 ≈ ${ms(wp)} vs ~${ms(rp)} afterwards (JIT, cold caches, lazy DB pool).`, "Send a short warm-up run first, or use Ramp-up so cold-start cost doesn't skew results.");
  }

  // ---- endpoints ----
  const live = eps.filter((e) => e.done > 0);
  if (live.length >= 2) {
    const sorted = [...live].map((e) => e.p95).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const slow = live.filter((e) => e.p95 > med * 2.5 && e.p95 > 100).sort((a, b) => b.p95 - a.p95).slice(0, 3);
    if (slow.length) add("warn", "Slowest endpoints", slow.map((e) => `${e.name}: p95 ${ms(e.p95)}`).join(" · "), "Start optimising here — these dominate your tail. Check for N+1 queries, missing indexes, unpaginated lists, or synchronous work.");
    const bad = live.filter((e) => e.errorPct > 1 && e.errorPct < 100).sort((a, b) => b.errorPct - a.errorPct).slice(0, 3);
    if (bad.length && !s5) add("warn", "Endpoints with errors", bad.map((e) => `${e.name}: ${pct(e.errorPct)}`).join(" · "), null);
  }

  // ---- payload ----
  const respBytes = t.bytes / t.done;
  const gz = Object.values(r.samples || {}).some((s) => (s.headers || {})["content-encoding"]);
  if (respBytes > 100_000) add("warn", "Large responses", `Average response is ${(respBytes / 1024).toFixed(0)} KB. At ${fmt(t.avgRps)} req/s that is ${((respBytes * t.avgRps) / 1e6).toFixed(0)} MB/s through the server.`, "Paginate, select fewer fields, enable gzip/brotli, and cache. Big JSON also costs CPU to serialize.");
  else if (!gz && respBytes > 4000) add("info", "Responses aren't compressed", `Average payload ${(respBytes / 1024).toFixed(1)} KB with no content-encoding.`, "Enable compression (Nginx gzip/brotli, or `compression` middleware) for text/JSON.");

  // ---- load generator health ----
  if (r.gen && r.gen.elP99Max > 40) {
    add("warn", "The load generator itself is struggling", `Event-loop lag in the test workers reached ${ms(r.gen.elP99Max)}. Measured latencies are inflated, and throughput is capped by this tool, not the server.`,
      "Increase Threads, reduce concurrency, close heavy apps, or run the tester on a different machine than the target.");
  } else if (r.system && t.avgRps > 3000) {
    add("info", "Tester and target share this machine", `At ${fmt(t.avgRps)} req/s both processes compete for ${r.system.cpus} CPU cores. Real capacity is likely higher with a dedicated load machine.`, null);
  }
  if (!cfg.keepAlive) add("info", "Keep-alive was OFF", "Every request opened a new TCP connection — this measures connection setup, and can exhaust ephemeral ports at high volume.", null);

  // ---- step test / capacity ----
  let capacity = null;
  if (r.phases && r.phases.length > 1 && cfg.mode === "steps") {
    const okLevels = r.phases.filter((p) => p.done > 0 && p.p95 <= slo.p95Ms && p.errorPct <= slo.errorPct);
    const best = okLevels.sort((a, b) => b.rps - a.rps)[0];
    const peak = [...r.phases].sort((a, b) => b.rps - a.rps)[0];
    const firstFail = r.phases.find((p) => p.done > 0 && (p.p95 > slo.p95Ms || p.errorPct > slo.errorPct));
    capacity = { sustainable: best ? { concurrency: best.concurrency, rps: best.rps, p95: best.p95 } : null, peak: { concurrency: peak.concurrency, rps: peak.rps }, breaksAt: firstFail ? firstFail.concurrency : null };
    if (best) add("good", `Sustainable capacity ≈ ${fmt(best.rps)} req/s`, `Best level that still met your SLO (p95 ≤ ${slo.p95Ms} ms, errors ≤ ${slo.errorPct}%) was ${best.concurrency} concurrent users: ${fmt(best.rps)} req/s at p95 ${ms(best.p95)}.`, null);
    else add("critical", "No step met your SLO", `Even the lowest level (${r.phases[0].concurrency} users) broke p95 ≤ ${slo.p95Ms} ms / errors ≤ ${slo.errorPct}%.`, "Optimise first, or loosen the SLO targets.");
    if (firstFail) add("warn", `Breaking point near ${firstFail.concurrency} concurrent users`, `At ${firstFail.concurrency} users: p95 ${ms(firstFail.p95)}, errors ${pct(firstFail.errorPct)}, ${fmt(firstFail.rps)} req/s.`, "Throughput flattening while latency rises is the signature of a bottleneck (CPU, DB pool, single-thread). Fix it, then re-run the step test and watch the knee move right.");
    const idx = r.phases.indexOf(peak);
    if (idx >= 0 && idx < r.phases.length - 1 && r.phases[r.phases.length - 1].rps < peak.rps * 0.8)
      add("warn", "Throughput collapses under overload", `Peak was ${fmt(peak.rps)} req/s at ${peak.concurrency} users, but fell to ${fmt(r.phases[r.phases.length - 1].rps)} req/s at ${r.phases[r.phases.length - 1].concurrency} users.`, "The app degrades instead of shedding load. Add timeouts, bounded queues, and backpressure (503 + Retry-After) so overload doesn't snowball.");
  }

  // ---- verdict ----
  const sloP95 = t.p95 <= slo.p95Ms;
  const sloErr = t.errorPct <= slo.errorPct;
  let status = sloP95 && sloErr ? "PASS" : "FAIL";
  if (cfg.mode === "steps" && capacity) status = capacity.sustainable ? (capacity.breaksAt ? "LIMIT FOUND" : "PASS") : "FAIL";
  let headline;
  if (cfg.mode === "steps" && capacity) headline = capacity.sustainable ? `Handles ~${fmt(capacity.sustainable.rps)} req/s within SLO` + (capacity.breaksAt ? `; breaks near ${capacity.breaksAt} users` : "; no breaking point reached — raise the levels") : "Did not meet SLO at any level";
  else if (status === "PASS") headline = `${fmt(t.avgRps)} req/s, p95 ${ms(t.p95)}, ${pct(t.errorPct)} errors`;
  else headline = [!sloP95 && `p95 ${ms(t.p95)} > ${slo.p95Ms} ms`, !sloErr && `errors ${pct(t.errorPct)} > ${slo.errorPct}%`].filter(Boolean).join(" · ");

  // ---- WHY did it fail? when did the errors happen ----
  let why = null;
  {
    const full = r.timeline || [];
    const errSecs = full.filter((p) => p.errors > 0);
    const totalErr = t.errors;
    const stat5 = Object.entries(st).filter(([k]) => /^5/.test(k)).reduce((a, [, v]) => a + v, 0);
    if (totalErr > 0 && full.length >= 4 && t.errorPct > slo.errorPct) {
      const early = full.slice(0, 3).reduce((a, p) => a + p.errors, 0);
      const share = early / totalErr;
      const lastErr = errSecs.length ? errSecs[errSecs.length - 1].t : 0;
      const clean = full.filter((p) => p.t > lastErr && p.rps > 0);
      const cleanAvgRps = clean.length ? clean.reduce((a, p) => a + p.rps, 0) / clean.length : 0;
      const cleanP95 = clean.length ? Math.max(...clean.map((p) => p.p95)) : 0;
      const kind = stat5 >= dropped ? "HTTP 500 errors from your code" : "network connections dropped";
      if (share >= 0.8 && clean.length >= 3) {
        why = `${fmt(totalErr)} requests failed (${kind}), ${pct(share * 100)} of them in the first ${Math.min(3, full.length)} seconds, when ${fmt(users)} users all connected at once. After that: ${clean.length} s with 0 errors at ~${fmt(cleanAvgRps)} req/s.`;
        add("critical", "Why this run failed: a connection burst at the start",
          `${fmt(early)} of ${fmt(totalErr)} errors happened in the first 3 seconds, while ${fmt(users)} users were opening connections at the same moment. From second ${lastErr + 1} on the app ran ${clean.length} seconds with zero errors at ~${fmt(cleanAvgRps)} req/s (p95 ≤ ${ms(cleanP95)}). So the app can carry this load — it could not accept that many new connections in one instant.`,
          "1) Use Ramp-up so users join gradually (real users do). 2) Raise the server's accept queue: Node `server.listen(port, { backlog: 1024 })`, macOS `sudo sysctl -w kern.ipc.somaxconn=1024`. 3) Make sure `ulimit -n` is high. 4) In production an Nginx/load balancer in front smooths bursts like this.");
      } else if (errSecs.length >= full.length * 0.6) {
        why = `${fmt(totalErr)} requests failed (${kind}) throughout the run, not just at the start — the app cannot sustain ${fmt(users)} users.`;
        add("critical", "Why this run failed: errors throughout the run",
          `Errors appeared in ${errSecs.length} of ${full.length} seconds (${pct(t.errorPct)} overall). The app can't keep up with ${fmt(users)} users.`,
          "Find the limit with a Step test (smaller levels), then check logs for what breaks first: DB pool, CPU, memory, or crashes.");
      } else {
        why = `${fmt(totalErr)} requests failed (${kind}) in ${errSecs.length} short bursts during the run.`;
        add("warn", "Why this run failed: intermittent error bursts",
          `Errors appeared in ${errSecs.length} of ${full.length} seconds (${pct(t.errorPct)} overall), in bursts rather than constantly.`,
          "Bursts often mean a restart, GC pause, a connection-pool refill, or a periodic job. Compare the burst times with your app logs.");
      }
    }
  }

  if (!out.some((i) => i.level === "critical" || i.level === "warn")) {
    add("good", "Healthy under this load", `No errors beyond budget and latency is stable (p95 ${ms(t.p95)}).`,
      cfg.mode === "steps" ? "Increase the step levels to find the ceiling." : "Run a Step test (10 → 400 users) to find where it actually breaks, or try 5–10× the volume.");
  }
  const order = { critical: 0, warn: 1, info: 2, good: 3 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  return { verdict: { status, headline, sloP95, sloErr, reason: why }, insights: out, capacity };
}

module.exports = { analyze };
