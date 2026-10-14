import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// __LTC_BUILD__: the Git commit this build comes from (Vercel sets
// VERCEL_GIT_COMMIT_SHA when it builds); "dev" locally. See buildInfo.js.
// The same id is published at /version.json, so the owner can confirm what the
// live site actually serves before approving a release (RELEASE_RUNBOOK.md).
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || process.env.LTC_BUILD || "dev";
const versionJson = {
  name: "ltc-version-json",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) + "\n" });
  },
};

export default defineConfig({
  plugins: [react(), versionJson],
  define: {
    __LTC_BUILD__: JSON.stringify(BUILD_ID),
  },
});
