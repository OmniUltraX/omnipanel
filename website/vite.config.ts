import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** 线上为自定义域名根路径；本地未设置时仍用项目页 /omnipanel/ */
const base = process.env.GITHUB_PAGES_BASE ?? "/omnipanel/";
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base,
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(root, "index.html"),
        plugins: path.resolve(root, "plugins.html"),
        pluginsDocs: path.resolve(root, "plugins/docs.html"),
        download: path.resolve(root, "download.html"),
      },
    },
  },
});
