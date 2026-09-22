import type { AgentAdapter, AgentInstallStatus } from "./types";
import { formatLaunchCommand } from "./types";

function createExternalAcpAdapter(
  kind: AgentAdapter["kind"],
  nameKey: string,
  descriptionKey: string,
): AgentAdapter {
  return {
    kind,
    nameKey,
    descriptionKey,
    buildLaunchCommand(status: AgentInstallStatus) {
      return formatLaunchCommand(status);
    },
    usesOmniPanelMcp() {
      return true;
    },
  };
}

export const cursorAgentAdapter = createExternalAcpAdapter(
  "cursor",
  "settings.agents.cursor.name",
  "settings.agents.cursor.desc",
);

export const opencodeAgentAdapter = createExternalAcpAdapter(
  "opencode",
  "settings.agents.opencode.name",
  "settings.agents.opencode.desc",
);

export const AGENT_ADAPTERS: AgentAdapter[] = [
  cursorAgentAdapter,
  opencodeAgentAdapter,
];

export function getAgentAdapter(kind: AgentAdapter["kind"]): AgentAdapter {
  const adapter = AGENT_ADAPTERS.find((item) => item.kind === kind);
  if (!adapter) {
    throw new Error(`未知 Agent 类型: ${kind}`);
  }
  return adapter;
}
