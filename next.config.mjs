/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the app was written/tested without double-invoked effects
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/(.*)", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};
export default nextConfig;
