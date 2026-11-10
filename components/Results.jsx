"use client";
import { useMemo } from "react";
import { LineChart, Legend, Histogram } from "./Charts";
import { num, ms, pct, bytes, dur } from "./format";

const SC = { p50: "#60a5fa", p95: "#fbbf24", p99: "#f472b6", rps: "#5eead4", err: "#f87171" };
const statusColor = (k) => (k === "ERR" ? "#f87171" : k[0] === "2" ? "#4ade80" : k[0] === "3" ? "#60a5fa" : k[0] === "4" ? "#fbbf24" : "#f87171");
const ERR_HELP = {
  ECONNRESET: "The server (or OS) abruptly closed the connection while the request was in flight. Typical when too many connections arrive at once, or the process crashed/restarted.",
  EPIPE: "We tried to send on a connection the server had already closed.",
  ECONNREFUSED: "Nothing accepted the connection: the app is down, on another port, or its connection queue is full.",
  TIMEOUT: "No answer within the timeout. The server is too slow or overloaded.",
  ABORTED: "The server cut the response off half-way.",
  EADDRNOTAVAIL: "The tester ran out of local ports (not the server's fault).",
  EMFILE: "The tester hit the OS open-files limit (not the server's fault).",
};
const STATUS_HELP = { 500: "Your code threw an error or a dependency (DB) failed", 502: "Bad gateway: an upstream service failed", 503: "Server overloaded or unavailable", 504: "Upstream timed out", 429: "Rate limiter rejected the request", 404: "Path does not exist", 401: "Not authenticated", 403: "Forbidden", 400: "Request rejected as invalid" };
const ICON = { critical: "⛔", warn: "⚠️", info: "ℹ️", good: "✅" };

function Kpi({ label, value, sub, tone, children }) {
  return (<div className={"kpi " + (tone || "")}><span className="k">{label}</span><b className="v">{value}</b>{sub && <span className="s">{sub}</span>}{children}</div>);
}

export default function Results({ v, cfg }) {
  const t = v.totals;
  const running = v.state === "running" || v.state === "stopping";
  const isSteps = cfg?.mode === "steps";
  const an = v.analysis;

  const tl = v.timeline || [];
  const xs = useMemo(() => tl.map((p) => p.t), [tl]);
  const rpsSeries = useMemo(() => [{ key: "rps", label: "Requests/s", color: SC.rps, data: tl.map((p) => p.rps) }, { key: "err", label: "Errors/s", color: SC.err, data: tl.map((p) => p.errors) }], [tl]);
  const latSeries = useMemo(() => [
    { key: "p50", label: "p50", color: SC.p50, data: tl.map((p) => p.p50) },
    { key: "p95", label: "p95", color: SC.p95, data: tl.map((p) => p.p95) },
    { key: "p99", label: "p99", color: SC.p99, data: tl.map((p) => p.p99) },
  ], [tl]);
  const marks = useMemo(() => [{ v: t.p50, label: "p50", color: SC.p50 }, { v: t.p95, label: "p95", color: SC.p95 }, { v: t.p99, label: "p99", color: SC.p99 }], [t.p50, t.p95, t.p99]);

  const progress = v.total ? Math.min(100, (t.done / v.total) * 100) : cfg ? Math.min(100, (v.elapsed / Math.max(1, cfg.mode === "steps" ? cfg.steps.levels.length * cfg.steps.secondsPerStep : cfg.durationSec)) * 100) : 0;
  const statuses = Object.entries(t.status || {}).sort((a, b) => b[1] - a[1]);
  const stTotal = statuses.reduce((a, [, n]) => a + n, 0) || 1;

  const ph = v.phases || [];
  const phXs = ph.map((p) => p.concurrency);
  const stepRps = useMemo(() => [{ key: "rps", label: "Requests/s", color: SC.rps, data: ph.map((p) => p.rps) }], [ph]);
  const stepLat = useMemo(() => [{ key: "p50", label: "p50", color: SC.p50, data: ph.map((p) => p.p50) }, { key: "p95", label: "p95", color: SC.p95, data: ph.map((p) => p.p95) }], [ph]);

  const vs = an?.verdict;
  return (
    <div className="results">
      {vs && (
        <div className={"verdict " + vs.status.replace(/\s/g, "-").toLowerCase()}>
          <div className="vbadge">{vs.status}</div>
          <div><b>{vs.headline}</b><span>{v.state === "stopped" ? "Stopped early · " : ""}{num(t.done)} requests in {dur(v.elapsed)} · target {cfg?.base}</span>{vs.reason && <span className="why"><strong>Why:</strong> {vs.reason}</span>}</div>
        </div>
      )}
      {v.state === "failed" && <div className="verdict fail"><div className="vbadge">ERROR</div><div><b>{v.error || "The run failed"}</b></div></div>}

      <div className="kpis">
        <Kpi label={running ? "Progress" : "Completed"} value={`${num(t.done)}${v.total ? " / " + num(v.total) : ""}`} sub={running ? `${dur(v.elapsed)} elapsed${v.eta != null ? " · ~" + dur(v.eta) + " left" : ""}${v.phase?.count > 1 ? ` · step ${v.phase.index + 1}/${v.phase.count} (${v.phase.concurrency} users)` : ""}` : `in ${dur(v.elapsed)}`}>
          <div className="bar"><i style={{ width: progress + "%" }} className={running ? "live" : ""} /></div>
        </Kpi>
        <Kpi label={running ? "Requests / sec (live)" : "Requests / sec"} value={num(v.rps)} sub={`peak ${num(v.peakRps)} · avg ${num(t.avgRps)}`} tone="teal" />
        <Kpi label="Latency p95" value={ms(t.p95)} sub={`p50 ${ms(t.p50)} · p99 ${ms(t.p99)}`} tone={cfg && t.p95 > cfg.slo.p95Ms ? "bad" : ""} />
        <Kpi label="Errors" value={pct(t.errorPct)} sub={`${num(t.errors)} failed · ${num(Object.entries(t.status || {}).filter(([k]) => /^5/.test(k)).reduce((a, [, n]) => a + n, 0))} HTTP 5xx · ${num(t.status?.ERR || 0)} network`} tone={t.errors ? "bad" : "good"} />
        <Kpi label="Avg · min · max" value={ms(t.avg)} sub={`${ms(t.min)} – ${ms(t.max)}`} />
        <Kpi label="Data received" value={bytes(t.bytes)} sub={`${bytes(t.bytes / Math.max(1, v.elapsed))}/s`} />
      </div>

      {isSteps && ph.length > 0 && (
        <section className="card">
          <h3>Step test <small>find the breaking point</small></h3>
          <div className="two">
            <div><h4>Throughput vs users</h4><LineChart xs={phXs} series={stepRps} yFmt={(x) => num(x)} xFmt={(x) => x + " users"} height={170} /></div>
            <div><h4>Latency vs users</h4><LineChart xs={phXs} series={stepLat} yFmt={ms} xFmt={(x) => x + " users"} height={170} refLine={cfg ? { value: cfg.slo.p95Ms, label: "SLO p95", color: "#f87171" } : null} area={false} /><Legend items={stepLat} /></div>
          </div>
          <table className="tbl">
            <thead><tr><th>Users</th><th>Req/s</th><th>p50</th><th>p95</th><th>p99</th><th>Errors</th><th>SLO</th></tr></thead>
            <tbody>{ph.map((p) => { const ok = p.p95 <= cfg.slo.p95Ms && p.errorPct <= cfg.slo.errorPct; return (<tr key={p.label}><td>{p.concurrency}</td><td>{num(p.rps)}</td><td>{ms(p.p50)}</td><td>{ms(p.p95)}</td><td>{ms(p.p99)}</td><td>{pct(p.errorPct)}</td><td><span className={"pill " + (ok ? "good" : "bad")}>{ok ? "OK" : "BREACH"}</span></td></tr>); })}</tbody>
          </table>
        </section>
      )}

      <div className="two">
        <section className="card"><h3>Throughput <small>requests per second</small></h3><LineChart xs={xs} series={rpsSeries} yFmt={(x) => num(x)} xFmt={(x) => x + "s"} /><Legend items={rpsSeries} /></section>
        <section className="card"><h3>Latency over time</h3><LineChart xs={xs} series={latSeries} yFmt={ms} xFmt={(x) => x + "s"} area={false} /><Legend items={latSeries} /></section>
      </div>

      <div className="two">
        <section className="card"><h3>Latency distribution <small>log scale</small></h3><Histogram bars={v.bars} marks={marks} /></section>
        <section className="card">
          <h3>Responses</h3>
          <div className="stack">{statuses.map(([k, n]) => (<i key={k} title={`${k}: ${num(n)}`} style={{ width: (n / stTotal) * 100 + "%", background: statusColor(k) }} />))}</div>
          <div className="stlist">{statuses.map(([k, n]) => (<span key={k}><i style={{ background: statusColor(k) }} /><b>{k === "ERR" ? "Network error" : k}</b> {num(n)} <em>{pct((n / stTotal) * 100)}</em></span>))}</div>
          {Object.keys(t.errTypes || {}).length > 0 && (
            <div className="errhelp">
              <h4>What the errors mean</h4>
              {Object.entries(t.errTypes).map(([k, n]) => (<p key={k}><span className="pill bad">{k} ×{num(n)}</span> {ERR_HELP[k] || "Network-level failure."}</p>))}
            </div>
          )}
          {statuses.filter(([k]) => STATUS_HELP[k] && k !== "200").length > 0 && (
            <div className="errhelp">
              {statuses.filter(([k]) => STATUS_HELP[k]).map(([k, n]) => (<p key={k}><span className="pill warn">{k} ×{num(n)}</span> {STATUS_HELP[k]}.</p>))}
            </div>
          )}
          {!statuses.length && <p className="muted">No responses yet.</p>}
        </section>
      </div>

      {an && (
        <section className="card insights">
          <h3>Analysis & suggestions <small>{an.insights.length} findings</small></h3>
          {an.insights.map((i, n) => (
            <div key={n} className={"insight " + i.level}>
              <span className="ic">{ICON[i.level]}</span>
              <div><b>{i.title}</b><p>{i.detail}</p>{i.fix && <p className="fix"><strong>How to improve:</strong> {i.fix}</p>}</div>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h3>Per endpoint</h3>
        <div className="scroll">
          <table className="tbl">
            <thead><tr><th className="l">Endpoint</th><th>Requests</th><th>Req/s</th><th>Avg</th><th>p50</th><th>p95</th><th>p99</th><th>Errors</th><th>Avg size</th></tr></thead>
            <tbody>{(v.eps || []).map((e) => (<tr key={e.name}><td className="ep-name">{e.name}</td><td>{num(e.done)}</td><td>{num(e.rps, 1)}</td><td>{ms(e.avg)}</td><td>{ms(e.p50)}</td><td>{ms(e.p95)}</td><td>{ms(e.p99)}</td><td className={e.errorPct > 1 ? "red" : ""}>{pct(e.errorPct)}</td><td>{bytes(e.avgBytes)}</td></tr>))}</tbody>
          </table>
        </div>
      </section>

      {v.system && <p className="foot">Tested on {v.system.cpuModel} · {v.system.cpus} cores · {v.system.totalMemGB} GB · Node {v.system.node} · {v.gen?.threads} load threads</p>}
    </div>
  );
}
