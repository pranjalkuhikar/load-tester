"use client";
import { useState } from "react";
import { num, ms, pct, when } from "./format";

export default function History({ items, current, onOpen, onDelete, onReuse }) {
  const [sel, setSel] = useState([]);
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));
  const cmp = sel.map((id) => items.find((i) => i.id === id)).filter(Boolean);
  const diff = (a, b, lowerBetter = true) => {
    if (!a || !b || !isFinite(a) || !isFinite(b) || a === 0) return "";
    const d = ((b - a) / a) * 100;
    const good = lowerBetter ? d < 0 : d > 0;
    return <em className={Math.abs(d) < 2 ? "" : good ? "up" : "down"}>{d > 0 ? "+" : ""}{d.toFixed(0)}%</em>;
  };
  if (!items.length) return null;
  return (
    <section className="card history">
      <h3>History <small>{items.length} runs · tick two to compare</small></h3>
      {cmp.length === 2 && (
        <table className="tbl cmp">
          <thead><tr><th></th><th>Run A</th><th>Run B</th><th>Change</th></tr></thead>
          <tbody>
            <tr><td>When</td><td>{when(cmp[0].startedAt)}</td><td>{when(cmp[1].startedAt)}</td><td></td></tr>
            <tr><td>Requests/s</td><td>{num(cmp[0].rps)}</td><td>{num(cmp[1].rps)}</td><td>{diff(cmp[0].rps, cmp[1].rps, false)}</td></tr>
            <tr><td>p50</td><td>{ms(cmp[0].p50)}</td><td>{ms(cmp[1].p50)}</td><td>{diff(cmp[0].p50, cmp[1].p50)}</td></tr>
            <tr><td>p95</td><td>{ms(cmp[0].p95)}</td><td>{ms(cmp[1].p95)}</td><td>{diff(cmp[0].p95, cmp[1].p95)}</td></tr>
            <tr><td>p99</td><td>{ms(cmp[0].p99)}</td><td>{ms(cmp[1].p99)}</td><td>{diff(cmp[0].p99, cmp[1].p99)}</td></tr>
            <tr><td>Error rate</td><td>{pct(cmp[0].errorPct)}</td><td>{pct(cmp[1].errorPct)}</td><td>{diff(cmp[0].errorPct, cmp[1].errorPct)}</td></tr>
          </tbody>
        </table>
      )}
      <div className="scroll">
        <table className="tbl">
          <thead><tr><th></th><th className="l">When</th><th className="l">Run</th><th>Requests</th><th>Req/s</th><th>p95</th><th>Errors</th><th>Result</th><th></th></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className={current === r.id ? "cur" : ""}>
                <td><input type="checkbox" checked={sel.includes(r.id)} onChange={() => toggle(r.id)} /></td>
                <td className="l">{when(r.startedAt)}</td>
                <td className="ep-name"><a onClick={() => onOpen(r.id)}>{r.name || r.base.replace(/^https?:\/\//, "")}</a><em>{r.mode} · {r.concurrency} users</em></td>
                <td>{num(r.done)}</td><td>{num(r.rps)}</td><td>{ms(r.p95)}</td><td className={r.errorPct > 1 ? "red" : ""}>{pct(r.errorPct)}</td>
                <td>{r.verdict ? <span className={"pill " + (r.verdict.status === "PASS" ? "good" : r.verdict.status === "FAIL" ? "bad" : "warn")}>{r.verdict.status}</span> : "–"}</td>
                <td className="acts"><button className="icon" title="Reuse this config" onClick={() => onReuse(r.id)}>↺</button><button className="icon del" title="Delete" onClick={() => onDelete(r.id)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
