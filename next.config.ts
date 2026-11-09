import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Bundle the test scenarios, vendor master and recorded AI readings with the server functions.
  outputFileTracingIncludes: {
    "/api/**": ["./test-data/**/*", "./data/**/*"],
  },
};

export default nextConfig;
