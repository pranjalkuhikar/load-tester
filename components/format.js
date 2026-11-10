export const num = (n, d = 0) => (n == null || !isFinite(n) ? "–" : Number(n).toLocaleString("en-US", { maximumFractionDigits: d }));
export const ms = (n) => (n == null || !isFinite(n) ? "–" : n >= 1000 ? (n / 1000).toFixed(2) + " s" : n >= 100 ? n.toFixed(0) + " ms" : n >= 10 ? n.toFixed(1) + " ms" : n.toFixed(2) + " ms");
export const pct = (n) => (n == null || !isFinite(n) ? "–" : n === 0 ? "0%" : n < 0.01 ? "<0.01%" : n < 1 ? n.toFixed(2) + "%" : n.toFixed(1) + "%");
export const bytes = (n) => (n < 1024 ? n.toFixed(0) + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB");
export const dur = (s) => {
  if (s == null || !isFinite(s)) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(x).padStart(2, "0")}s` : `${x}s`;
};
export const when = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const short = (n) => (n >= 1e6 ? n / 1e6 + "M" : n >= 1e3 ? n / 1e3 + "k" : String(n));
