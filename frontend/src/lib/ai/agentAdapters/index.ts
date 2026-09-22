import { useCliProvidersStore } from "../../../stores/cliProvidersStore";
import { openCodeAgentAdapter } from "./opencodeAdapter";
import type { AgentAdapter } from "./types";

/** 当前启用的互斥智能体对应的适配器；无则走内置 aiStore。 */
export function resolveActiveAgentAdapter(): AgentAdapter | null {
  const providers = useCliProvidersStore.getState().providers;
  const opencode = providers.find((p) => p.id === "opencode");
  if (opencode?.enabled) {
    return openCodeAgentAdapter;
  }
  return null;
}

export function useActiveAgentAdapter(): AgentAdapter | null {
  const enabled = useCliProvidersStore((s) =>
    s.providers.some((p) => p.id === "opencode" && p.enabled),
  );
  return enabled ? openCodeAgentAdapter : null;
}

export type { AgentAdapter, AgentSessionSummary, AgentChatMessage, OpenCodeAgentSummary } from "./types";
export { isAgentSessionId, isSelectableOpenCodeAgent } from "./types";
export { openCodeAgentAdapter } from "./opencodeAdapter";
