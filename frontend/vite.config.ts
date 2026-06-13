import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));

const shimsDir = path.resolve(frontendRoot, "src/shims");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: [
      { find: "@repo-logo", replacement: path.resolve(frontendRoot, "../logo") },
      {
        find: "standardwebhooks-cjs",
        replacement: path.resolve(frontendRoot, "../node_modules/standardwebhooks/dist/index.js"),
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
      "langchain",
      "@langchain/core",
      "@langchain/openai",
      "@langchain/anthropic",
      "@anthropic-ai/sdk",
      "standardwebhooks",
      "standardwebhooks-cjs",
      "@stablelib/base64",
      "fast-sha256",
      "@langchain/langgraph",
      "@langchain/langgraph-sdk",
      "js-tiktoken",
      "langsmith",
      "dockview-react",
      "dockview",
      "dockview-core",
    ],
    exclude: [
      "node-ipc",
      "picomatch",
      "node-sql-parser",
      "@langchain/tavily",
      "@langchain/langgraph-checkpoint",
      "@langchain/protocol",
      "@cfworker/json-schema",
      "mustache",
      "p-retry",
      "uuid",
      "zod-to-json-schema",
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
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
