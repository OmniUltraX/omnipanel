import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** GitHub Pages 项目站路径，如 https://omniultrax.github.io/omnipanel/ */
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
      },
    },
  },
});
