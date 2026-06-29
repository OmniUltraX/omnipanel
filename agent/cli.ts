import { startAcpServer } from "./adapters/acp/index.js";
import { startWebServer } from "./adapters/web/index.js";

/** OmniAgent 启动模式：acp = ACP stdio；web = HTTP + assistant-ui 客户端。 */
export type OmniAgentMode = "acp" | "web";

const MODES: OmniAgentMode[] = ["acp", "web"];

export function resolveOmniAgentMode(argv: readonly string[] = process.argv): OmniAgentMode {
  const envMode = process.env.OMNIAGENT_MODE?.trim().toLowerCase();
  if (envMode && MODES.includes(envMode as OmniAgentMode)) {
    return envMode as OmniAgentMode;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode" || arg === "-m") {
      const next = argv[i + 1]?.trim().toLowerCase();
      if (next && MODES.includes(next as OmniAgentMode)) {
        return next as OmniAgentMode;
      }
    }
    if (arg === "--web") return "web";
    if (arg === "--acp") return "acp";
  }

  return "acp";
}

export function printOmniAgentHelp(): void {
  console.error(`OmniAgent — DeepAgents + Skills + MCP

目录结构:
  core/       Agent 核心（runtime、turn、sessions、config）
  adapters/   传输适配器（acp、web）
  dev-ui/     Web 模式 assistant-ui 客户端

启动模式:
  acp (默认)  ACP stdio → adapters/acp
  web         HTTP API  → adapters/web + dev-ui

用法:
  node --import tsx index.ts [--mode acp|web]
  OMNIAGENT_MODE=web node --import tsx index.ts

npm scripts:
  npm start           acp 模式
  npm run start:web   web 模式（API 9477 + UI 9478，浏览器打开后者）

配置:
  OMNIAGENT_CONFIG    模型配置文件路径
  web 模式另可放置 agent/debug-config.json
`);
}

export function runOmniAgent(argv: readonly string[] = process.argv): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    printOmniAgentHelp();
    process.exit(0);
  }

  const mode = resolveOmniAgentMode(argv);
  if (mode === "web") {
    startWebServer();
    return;
  }
  startAcpServer();
}
