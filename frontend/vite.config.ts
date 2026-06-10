import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@repo-logo": path.resolve(frontendRoot, "../logo"),
      util: "node:util",
      path: "node:path",
      os: "node:os",
      crypto: "node:crypto",
      stream: "node:stream",
      buffer: "node:buffer",
      events: "node:events",
      url: "node:url",
      querystring: "node:querystring",
      zlib: "node:zlib",
      assert: "node:assert",
      string_decoder: "node:string_decoder",
      punycode: "node:punycode",
    },
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
      // langchain / deepagents 链路上的 CJS 包需要预构建 default 互操作
      "base64-js",
      "deepagents",
      "fast-glob",
      "micromatch",
      "yaml",
      "langchain",
      "@langchain/core",
      "@langchain/openai",
      "@langchain/langgraph",
      "@langchain/langgraph-sdk",
      "js-tiktoken",
      "langsmith",
      "rc-dock",
    ],
    exclude: [
      "node-ipc",
      "picomatch",
      "node-sql-parser",
      "@langchain/anthropic",
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
