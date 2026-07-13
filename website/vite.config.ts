import { defineConfig } from "vite";

/** GitHub Pages 项目站路径，如 https://anomalyco.github.io/omnipanel/ */
const base = process.env.GITHUB_PAGES_BASE ?? "/omnipanel/";

export default defineConfig({
  base,
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
