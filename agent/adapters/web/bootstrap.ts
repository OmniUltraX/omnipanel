import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agentRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Web 模式启动前：若未设置 OMNIAGENT_CONFIG，尝试加载 agent/debug-config.json。 */
export function ensureWebConfigEnv(): void {
  if (process.env.OMNIAGENT_CONFIG?.trim()) return;
  const localConfig = path.join(agentRoot, "debug-config.json");
  if (fs.existsSync(localConfig)) {
    process.env.OMNIAGENT_CONFIG = localConfig;
    console.error("[omniagent:web] 使用本地配置:", localConfig);
  }
}

export function parseWebPort(defaultPort = 9477): number {
  const raw =
    process.env.OMNIAGENT_WEB_PORT?.trim() ?? process.env.OMNIAGENT_DEBUG_PORT?.trim();
  if (!raw) return defaultPort;
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 ? port : defaultPort;
}
