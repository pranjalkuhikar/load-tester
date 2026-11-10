/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // data/ and engine/worker.js are read from disk at runtime; keep dev watcher quiet about run history
  turbopack: { root: import.meta.dirname },
};
export default nextConfig;
