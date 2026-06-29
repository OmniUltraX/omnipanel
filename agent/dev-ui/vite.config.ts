import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const devUiRoot = path.dirname(fileURLToPath(import.meta.url));
const debugPort = process.env.OMNIAGENT_DEBUG_PORT ?? "9477";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: devUiRoot,
  server: {
    host: "127.0.0.1",
    port: 9478,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${debugPort}`,
        changeOrigin: true,
      },
    },
  },
});
