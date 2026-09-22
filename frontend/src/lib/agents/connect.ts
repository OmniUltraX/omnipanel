import { connectAcpAgent } from "../acp/acpStream";
import { getAgentAdapter } from "./registry";
import type { AgentInstallStatus, AgentKind } from "./types";

/** 连接指定 Agent（统一入口）。 */
export async function connectAgentByKind(
  kind: AgentKind,
  installStatus: AgentInstallStatus,
  _modelSelectionId?: string | null,
): Promise<void> {
  const adapter = getAgentAdapter(kind);
  const commandLine = adapter.buildLaunchCommand(installStatus);
  if (!commandLine) {
    throw new Error("Agent 未安装或无法解析启动命令");
  }

  await connectAcpAgent(commandLine);
}
