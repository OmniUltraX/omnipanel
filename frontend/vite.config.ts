import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const requireFromFrontend = createRequire(import.meta.url);

const shimsDir = path.resolve(frontendRoot, "src/shims");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: [
      { find: "@repo-logo", replacement: path.resolve(frontendRoot, "../logo") },
      { find: "@/", replacement: `${path.resolve(frontendRoot, "src")}/` },
      {
        find: "standardwebhooks-cjs",
        replacement: requireFromFrontend.resolve("standardwebhooks/dist/index.js"),
      },
      { find: "standardwebhooks", replacement: path.join(shimsDir, "standardwebhooks.ts") },
    ],
  },
  define: {
    "process.env": {},
    "process.platform": '"browser"',
    "process.version": '""',
    "process.versions": "{}",
    global: "globalThis",
  },
  optimizeDeps: {
    include: [
      "p-queue",
      "eventemitter3",
      "p-timeout",
      "base64-js",
      "standardwebhooks-cjs",
      "@stablelib/base64",
      "fast-sha256",
      "dockview-react",
      "@assistant-ui/react",
      "@assistant-ui/react-markdown",
      "@assistant-ui/core",
    ],
    exclude: [
      "node-ipc",
      "picomatch",
      "node-sql-parser",
      "@cfworker/json-schema",
      "mustache",
      "p-retry",
      "uuid",
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: [frontendRoot, path.resolve(frontendRoot, "..")],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2022", "chrome120", "safari16"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@codemirror/")) {
            return "vendor-codemirror";
          }
          if (id.includes("node_modules/@xterm/")) {
            return "vendor-xterm";
          }
          if (id.includes("node_modules/dockview") || id.includes("node_modules/dockview-react")) {
            return "vendor-dockview";
          }
          if (
            id.includes("node_modules/@milkdown/") ||
            id.includes("node_modules/prosemirror")
          ) {
            return "vendor-milkdown";
          }
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});

