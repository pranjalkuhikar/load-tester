"use client";
import { useEffect, useRef, useState } from "react";

const C = { grid: "rgba(148,163,184,.14)", axis: "#8b98ad", text: "#cbd5e1" };

function useSize(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
const niceMax = (v) => {
  if (!v || v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};
function setup(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + "px"; canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  return ctx;
}

// xs: x labels/values · series: [{key,label,color,data[]}] · refLine: {value,label,color}
export function LineChart({ xs, series, height = 190, yFmt = (v) => v, xFmt = (v) => v, refLine, area = true, empty = "Waiting for data…" }) {
  const wrap = useRef(null), cv = useRef(null);
  const w = useSize(wrap);
  const [hover, setHover] = useState(null);
  const L = 50, R = 10, T = 10, B = 22;

  useEffect(() => {
    if (!w || !cv.current) return;
    const ctx = setup(cv.current, w, height);
    const n = xs.length;
    if (n < 1) { ctx.fillStyle = C.axis; ctx.textAlign = "center"; ctx.fillText(empty, w / 2, height / 2); return; }
    const pw = w - L - R, ph = height - T - B;
    let max = Math.max(...series.flatMap((s) => s.data), refLine ? refLine.value * 1.05 : 0, 0.0001);
    max = niceMax(max);
    const X = (i) => L + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const Y = (v) => T + ph - (v / max) * ph;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, y = Y(v);
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
      ctx.fillStyle = C.axis; ctx.fillText(yFmt(v), L - 6, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const ticks = Math.min(n, Math.max(2, Math.floor(pw / 80)));
    for (let k = 0; k < ticks; k++) {
      const i = ticks === 1 ? 0 : Math.round((k / (ticks - 1)) * (n - 1));
      ctx.fillStyle = C.axis; ctx.fillText(xFmt(xs[i], i), X(i), height - B + 6);
    }
    if (refLine) {
      const y = Y(refLine.value);
      ctx.setLineDash([5, 4]); ctx.strokeStyle = refLine.color || "#f87171"; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = refLine.color || "#f87171"; ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText(refLine.label, w - R, y - 2);
    }
    series.forEach((s, si) => {
      ctx.beginPath();
      s.data.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      if (area && si === 0 && n > 1) {
        ctx.lineTo(X(n - 1), Y(0)); ctx.lineTo(X(0), Y(0)); ctx.closePath();
        const g = ctx.createLinearGradient(0, T, 0, T + ph);
        g.addColorStop(0, s.color + "55"); g.addColorStop(1, s.color + "00");
        ctx.fillStyle = g; ctx.fill();
      }
      if (n <= 24) { ctx.fillStyle = s.color; s.data.forEach((v, i) => { ctx.beginPath(); ctx.arc(X(i), Y(v), 3, 0, 7); ctx.fill(); }); }
    });
    if (hover != null && hover < n) {
      ctx.strokeStyle = "rgba(226,232,240,.4)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(hover), T); ctx.lineTo(X(hover), T + ph); ctx.stroke();
      series.forEach((s) => { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(hover), Y(s.data[hover]), 4, 0, 7); ctx.fill(); });
    }
  }, [w, xs, series, height, hover, refLine]);

  const onMove = (e) => {
    const r = cv.current.getBoundingClientRect();
    const n = xs.length; if (!n) return;
    const x = e.clientX - r.left - L;
    setHover(Math.max(0, Math.min(n - 1, Math.round((x / (w - L - R)) * (n - 1)))));
  };
  const hx = hover != null && xs.length ? L + (xs.length === 1 ? (w - L - R) / 2 : (hover / (xs.length - 1)) * (w - L - R)) : 0;

  return (
    <div ref={wrap} className="chart" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <canvas ref={cv} />
      {hover != null && xs[hover] !== undefined && (
        <div className="tip" style={{ left: hx > w / 2 ? undefined : hx + 12, right: hx > w / 2 ? w - hx + 12 : undefined, top: 8 }}>
          <b>{xFmt(xs[hover], hover, true)}</b>
          {series.map((s) => (<div key={s.key}><i style={{ background: s.color }} />{s.label}: <b>{yFmt(s.data[hover])}</b></div>))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }) {
  return (<div className="legend">{items.map((s) => (<span key={s.key}><i style={{ background: s.color }} />{s.label}</span>))}</div>);
}

// latency distribution on a log-x axis. bars: [[ms,count],...]
export function Histogram({ bars, marks = [], height = 170 }) {
  const wrap = useRef(null), cv = useRef(null);
  const w = useSize(wrap);
  useEffect(() => {
    if (!w || !cv.current) return;
    const ctx = setup(cv.current, w, height);
    if (!bars || bars.length < 1) { ctx.fillStyle = C.axis; ctx.textAlign = "center"; ctx.fillText("Waiting for data…", w / 2, height / 2); return; }
    const L = 10, R = 10, T = 14, B = 22, pw = w - L - R, ph = height - T - B;
    const lo = Math.log(bars[0][0] / 1.2), hi = Math.log(bars[bars.length - 1][0] * 1.2);
    const X = (m) => L + ((Math.log(m) - lo) / (hi - lo || 1)) * pw;
    const mx = Math.max(...bars.map((b) => b[1]));
    const bw = Math.max(2, (Math.log(1.03) / (hi - lo || 1)) * pw);
    ctx.fillStyle = "#60a5fa";
    for (const [m, c] of bars) { const h = Math.max(1.5, (c / mx) * ph); ctx.globalAlpha = 0.85; ctx.fillRect(X(m) - bw, T + ph - h, bw, h); }
    ctx.globalAlpha = 1;
    ctx.textBaseline = "top"; ctx.textAlign = "center"; ctx.fillStyle = C.axis;
    const ticks = [0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 60000].filter((t) => t >= bars[0][0] / 1.2 && t <= bars[bars.length - 1][0] * 1.2);
    for (const t of ticks) { ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(X(t), T); ctx.lineTo(X(t), T + ph); ctx.stroke(); ctx.fillText(t >= 1000 ? t / 1000 + "s" : t + "ms", X(t), height - B + 6); }
    marks.forEach((mk, i) => {
      if (!mk.v) return;
      const x = X(mk.v);
      ctx.strokeStyle = mk.color; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, T - 4); ctx.lineTo(x, T + ph); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = mk.color; ctx.textBaseline = "bottom"; ctx.textAlign = x > w - 40 ? "right" : "center"; ctx.fillText(mk.label, x, T - 3 + (i % 2) * 0);
    });
  }, [w, bars, marks, height]);
  return (<div ref={wrap} className="chart" style={{ height }}><canvas ref={cv} /></div>);
}
