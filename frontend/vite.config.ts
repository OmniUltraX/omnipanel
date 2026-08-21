import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import checker from "vite-plugin-checker";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const requireFromFrontend = createRequire(import.meta.url);

const shimsDir = path.resolve(frontendRoot, "src/shims");

/** Web 模式（非 Tauri）下把 @tauri-apps/api 重定向到浏览器 shim；Tauri 构建走真实现。 */
const isWebBuild = process.env.OMNIPANEL_WEB === "1";
const webAliases = isWebBuild
  ? [
      {
        find: "@tauri-apps/api/core",
        replacement: path.join(shimsDir, "tauri/core-web.ts"),
      },
      {
        find: "@tauri-apps/api/event",
        replacement: path.join(shimsDir, "tauri/event.ts"),
      },
      {
        find: "@tauri-apps/api/window",
        replacement: path.join(shimsDir, "tauri/window.ts"),
      },
      {
        find: "@tauri-apps/api/webviewWindow",
        replacement: path.join(shimsDir, "tauri/webviewWindow.ts"),
      },
      {
        find: "@tauri-apps/api/dpi",
        replacement: path.join(shimsDir, "tauri/dpi.ts"),
      },
      // menu / tray / app 桌面专属 → 统一 no-op shim
      {
        find: "@tauri-apps/api/menu",
        replacement: path.join(shimsDir, "tauri/desktop.ts"),
      },
      {
        find: "@tauri-apps/api/tray",
        replacement: path.join(shimsDir, "tauri/desktop.ts"),
      },
      {
        find: "@tauri-apps/api/app",
        replacement: path.join(shimsDir, "tauri/desktop.ts"),
      },
    ]
  : [];

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // Vite 8 + vite-plugin-checker 兼容 shim：
    // Vite 8 移除了 resolve 前的 stripBase，base 前缀的 runtime id 无法被插件 resolveId 匹配，
    // 这里手动把 base 前缀过的 id 映射回 virtual 模块。参见 nuxt/nuxt#35765、fi3ework/vite-plugin-checker#661
    {
      name: "vite-plugin-checker-runtime-base-fix",
      resolveId(id) {
        if (id.endsWith("/@vite-plugin-checker-runtime")) {
          return "virtual:@vite-plugin-checker-runtime";
        }
      },
    },
    // 仅 dev 模式启用 TS 检查；build 走 beforeBuildCommand 里的 `tsc -b`，避免重复
    ...(command === "serve"
      ? [
          checker({
            typescript: {
              // root tsconfig.json 是 solution-style（files:[] + references），
              // checker 用 tsc --noEmit 而非 tsc -b，需显式指向 app 配置才能命中 src/**
              tsconfigPath: "tsconfig.app.json",
            },
            overlay: { initialIsOpen: false },
          }),
        ]
      : []),
  ],
  clearScreen: false,
  resolve: {
    alias: [
      { find: "@repo-logo", replacement: path.resolve(frontendRoot, "../logo") },
      { find: "@/", replacement: `${path.resolve(frontendRoot, "src")}/` },
      {
        find: "@omnipanel/plugin-sdk",
        replacement: path.resolve(frontendRoot, "../packages/plugin-sdk/src/index.ts"),
      },
      {
        find: "@omnipanel/plugin-ui",
        replacement: path.resolve(frontendRoot, "../packages/plugin-ui/src/index.ts"),
      },
      {
        find: /^zod$/,
        replacement: requireFromFrontend.resolve("zod"),
      },
      // Web 模式：把 @tauri-apps/api 重定向到浏览器 shim（仅 OMNIPANEL_WEB=1 时生效）
      ...webAliases,
      {
        find: "standardwebhooks-cjs",
        replacement: requireFromFrontend.resolve("standardwebhooks/dist/index.js"),
      },
      {
        find: "node-sql-parser-cjs",
        replacement: requireFromFrontend.resolve("node-sql-parser/index.js"),
      },
      { find: "standardwebhooks", replacement: path.join(shimsDir, "standardwebhooks.ts") },
      { find: "node-sql-parser", replacement: path.join(shimsDir, "node-sql-parser.ts") },
    ],
  },
  define: {
    "process.env": {},
    "process.platform": '"browser"',
    "process.version": '""',
    "process.versions": "{}",
    global: "globalThis",
    // Web 构建启用真实 PTY/SSH（TerminalView 等用 canUseTerminalBackend 判断）
    __OMNIPANEL_WEB__: JSON.stringify(isWebBuild),
  },
  optimizeDeps: {
    include: [
      "p-queue",
      "eventemitter3",
      "p-timeout",
      "standardwebhooks-cjs",
      "node-sql-parser-cjs",
      "@stablelib/base64",
      "fast-sha256",
      "dockview-react",
      "react-pdf",
      "pdfjs-dist",
      "@assistant-ui/react",
      "@assistant-ui/react-markdown",
      "@assistant-ui/core",
      "zod",
    ],
    exclude: [
      "node-ipc",
      "picomatch",
      "@cfworker/json-schema",
      "mustache",
      "p-retry",
      "uuid",
      // snap-layout 注入宏常量，避免 Vite 预打包缓存导致 __SNAP_BUTTON_ID__ 未定义
      "tauri-plugin-snap-layout",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
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
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "../plugins/**/*.test.ts",
    ],
  },
}));

