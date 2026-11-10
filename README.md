# LoadLab

Local load-testing app built with **Next.js** (UI + API in one project). Send 500 → 1,000,000 requests to any
app running on your machine and watch throughput, latency percentiles, errors per endpoint, and get suggestions.

```bash
npm install
npm run dev          # http://localhost:5050   (or: npm run build && npm start)
npm run demo-target  # optional practice API on :4100 (/fast /slow /cpu /flaky)
```

Modes: **Fixed requests**, **Duration**, **Step test** (raises users level by level to find the breaking point).
Endpoints can be auto-detected from a Next.js / Express project folder. Placeholders in paths/bodies:
`{{uuid}} {{int:1000}} {{rand:8}} {{ts}} {{pick:a|b|c}}`.

Safety: only `localhost` targets are allowed (set `ALLOW_REMOTE=1` to override, only for systems you own), and the
API only answers to the dashboard on a loopback host. Run history is stored in `data/runs/`.

Tip: benchmark a production build of your app (`next build && next start`), not `next dev`.
