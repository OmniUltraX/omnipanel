import { commands, type AgentInstallStatus as IpcAgentInstallStatus } from "../../ipc/bindings";
import { isTauriRuntime } from "../isTauriRuntime";
import { AGENT_ADAPTERS } from "./registry";
import type { AgentInstallStatus, AgentKind } from "./types";

function mapStatus(raw: IpcAgentInstallStatus): AgentInstallStatus {
  return {
    kind: raw.kind as AgentKind,
    installed: raw.installed,
    executablePath: raw.executablePath,
    version: raw.version,
    launchArgs: raw.launchArgs,
  };
}

/** 检测 Cursor / OpenCode 安装情况。 */
export async function detectAllAgents(): Promise<AgentInstallStatus[]> {
  if (!isTauriRuntime()) {
    return AGENT_ADAPTERS.map((adapter) => ({
      kind: adapter.kind,
      installed: false,
      executablePath: null,
      version: null,
      launchArgs: ["acp"],
    }));
  }

  const result = await commands.detectAllAgents();
  if (result.status === "error") {
    throw new Error(typeof result.error === "string" ? result.error : result.error.message ?? "Agent 检测失败");
  }
  return result.data
    .map(mapStatus)
    .filter((s): s is AgentInstallStatus => s.kind === "cursor" || s.kind === "opencode");
}

export function statusByKind(
  statuses: AgentInstallStatus[],
  kind: AgentKind,
): AgentInstallStatus | undefined {
  return statuses.find((item) => item.kind === kind);
}
