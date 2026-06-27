/** 与 Rust `AgentKind` 对齐的受支持 Agent 类型。 */
export type AgentKind = "omniagent" | "cursor" | "opencode" | "qwen";

export const SUPPORTED_AGENT_KINDS: AgentKind[] = ["omniagent", "cursor", "opencode", "qwen"];

/** 默认激活的 Agent（内置 OmniAgent）。 */
export const DEFAULT_AGENT_KIND: AgentKind = "omniagent";

/** Rust `detect_all_agents` 返回的安装状态。 */
export interface AgentInstallStatus {
  kind: AgentKind;
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  launchArgs: string[];
}

/** 统一 Agent 行为接口；具体 CLI 差异由适配器实现。 */
export interface AgentAdapter {
  readonly kind: AgentKind;
  readonly nameKey: string;
  readonly descriptionKey: string;

  /** 根据检测结果构建 `acp_connect` 命令行。 */
  buildLaunchCommand(status: AgentInstallStatus): string | null;

  /** 连接前是否需写入 acp-agent-config.json。 */
  requiresOmniPanelConfig(): boolean;

  /** 是否通过 ACP session/new 注入 OmniPanel MCP。 */
  usesOmniPanelMcp(): boolean;
}

export function agentKindToServiceId(kind: AgentKind): string {
  return kind;
}

export function isSupportedAgentKind(id: string): id is AgentKind {
  return SUPPORTED_AGENT_KINDS.includes(id as AgentKind);
}

export function formatLaunchCommand(status: AgentInstallStatus): string | null {
  if (!status.installed || !status.executablePath?.trim()) return null;
  const quoted =
    status.executablePath.includes(" ") ? `"${status.executablePath}"` : status.executablePath;
  const args = status.launchArgs.join(" ");
  return args ? `${quoted} ${args}` : quoted;
}
