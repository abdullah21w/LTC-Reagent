import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// __LTC_BUILD__: the Git commit this build comes from (Vercel sets
// VERCEL_GIT_COMMIT_SHA when it builds); "dev" locally. See buildInfo.js.
export default defineConfig({
  plugins: [react()],
  define: {
    __LTC_BUILD__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA || process.env.LTC_BUILD || "dev"),
  },
});
