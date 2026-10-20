import { defineConfig } from "vite";

/** 线上为自定义域名根路径；本地未设置时仍用项目页 /omnipanel/ */
const base = process.env.GITHUB_PAGES_BASE ?? "/omnipanel/";

export default defineConfig({
  base,
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
