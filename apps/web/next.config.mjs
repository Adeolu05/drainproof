import { fileURLToPath } from "node:url";

const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** @type {import("next").NextConfig} */
const config = {
  poweredByHeader: false,
  turbopack: { root: monorepoRoot },
  outputFileTracingRoot: monorepoRoot,
  // Demo mode (DRAINPROOF_DEMO=1) reads demo-runs/ at request time from a runtime path, which
  // the tracer cannot see. Include the reports in every server route so a serverless deployment
  // (for example Vercel) ships them.
  outputFileTracingIncludes: { "/**": ["./demo-runs/*.json"] },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
