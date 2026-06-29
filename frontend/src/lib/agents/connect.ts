import { connectAcpAgent } from "../acp/acpStream";
import { syncAcpAgentConfigFile } from "../acp/syncAgentConfig";
import { getAgentAdapter } from "./registry";
import type { AgentInstallStatus, AgentKind } from "./types";

/** 连接指定 Agent（统一入口）。 */
export async function connectAgentByKind(
  kind: AgentKind,
  installStatus: AgentInstallStatus,
  modelSelectionId?: string | null,
): Promise<void> {
  const adapter = getAgentAdapter(kind);
  const commandLine = adapter.buildLaunchCommand(installStatus);
  if (!commandLine) {
    throw new Error("Agent 未安装或无法解析启动命令");
  }

  if (adapter.requiresOmniPanelConfig()) {
    if (!modelSelectionId) {
      throw new Error("请先在「设置 → AI 模型」中配置模型");
    }
    await syncAcpAgentConfigFile(modelSelectionId);
  }

  await connectAcpAgent(commandLine);
}
