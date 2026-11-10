// Tiny sample API to practice on:  node demo-target.js   → http://localhost:4100
// /fast (instant) · /slow (~120ms) · /cpu (burns CPU, blocks the event loop) · /flaky (10% 500s) · /echo (POST)
const http = require("node:http");
const PORT = Number(process.env.PORT) || 4100;
let n = 0;
http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const url = req.url.split("?")[0];
  n++;
  if (url === "/fast") return send(200, { ok: true, n });
  if (url === "/slow") return setTimeout(() => send(200, { ok: true }), 100 + Math.random() * 40);
  if (url === "/cpu") { const t = Date.now(); while (Date.now() - t < 8); return send(200, { ok: true }); }
  if (url === "/flaky") return Math.random() < 0.1 ? send(500, { error: "boom" }) : send(200, { ok: true });
  if (url === "/echo" && req.method === "POST") { const c = []; req.on("data", (x) => c.push(x)); return req.on("end", () => send(200, { bytes: Buffer.concat(c).length })); }
  send(404, { error: "not found" });
}).listen(PORT, () => console.log(`demo target on http://localhost:${PORT}`));
