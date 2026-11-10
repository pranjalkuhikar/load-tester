// Log-scale latency histogram shared by workers and the orchestrator.
// Buckets grow by 3% each, starting at 50µs → ≤3% percentile error, tiny memory, cheap to merge.
const R = 1.03;
const BASE_US = 50;
const N = 520; // covers ~50µs … hours

const LN_R = Math.log(R);
function bucket(ms) {
  const us = ms * 1000;
  if (us <= BASE_US) return 0;
  const i = 1 + Math.floor(Math.log(us / BASE_US) / LN_R);
  return i >= N ? N - 1 : i;
}
// upper bound of a bucket, in ms
function bucketMs(i) {
  return (BASE_US * Math.pow(R, i)) / 1000;
}
function newHist() {
  return new Uint32Array(N);
}
function addHist(into, from) {
  for (let i = 0; i < N; i++) into[i] += from[i];
}
function histCount(h) {
  let c = 0;
  for (let i = 0; i < N; i++) c += h[i];
  return c;
}
// p in 0..100
function percentile(h, p, total = histCount(h)) {
  if (!total) return 0;
  const target = Math.max(1, Math.ceil((p / 100) * total));
  let acc = 0;
  for (let i = 0; i < N; i++) {
    acc += h[i];
    if (acc >= target) return bucketMs(i);
  }
  return bucketMs(N - 1);
}
function minMs(h) {
  for (let i = 0; i < N; i++) if (h[i]) return bucketMs(i > 0 ? i - 1 : 0);
  return 0;
}
function maxMs(h) {
  for (let i = N - 1; i >= 0; i--) if (h[i]) return bucketMs(i);
  return 0;
}
// Compact [{ms, count}] for charting (drops empty buckets)
function toBars(h) {
  const out = [];
  for (let i = 0; i < N; i++) if (h[i]) out.push([+bucketMs(i).toFixed(3), h[i]]);
  return out;
}

module.exports = { N, bucket, bucketMs, newHist, addHist, histCount, percentile, minMs, maxMs, toBars };
