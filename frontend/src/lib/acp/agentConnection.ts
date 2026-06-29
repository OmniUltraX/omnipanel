import { commands } from "../../ipc/bindings";
import { connectAgentByKind } from "../agents/connect";
import { statusByKind } from "../agents/detect";
import { getAgentAdapter } from "../agents/registry";
import {
  getActiveAgentKind,
  resolveAcpModelSelectionId,
  useAcpServicesStore,
} from "../../stores/acpServicesStore";
import { isTauriRuntime } from "../isTauriRuntime";
import { getAcpStatus } from "./acpStream";

export type AgentConnectionSnapshot = {
  connected: boolean;
  agentName: string | null;
};

export async function queryAgentConnectionSnapshot(): Promise<AgentConnectionSnapshot | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    const status = await getAcpStatus();
    return {
      connected: status.connected,
      agentName: status.agentName,
    };
  } catch {
    return { connected: false, agentName: null };
  }
}

export async function disconnectActiveAgent(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  const result = await commands.acpDisconnect();
  if (result.status === "error") {
    throw new Error(result.error);
  }
}

type ConnectActiveAgentMessages = {
  notInstalled: (agentLabel: string) => string;
  modelRequired: string;
  notLaunchable: string;
};

export async function connectActiveAgent(
  messages: ConnectActiveAgentMessages,
): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  const state = useAcpServicesStore.getState();
  const kind = getActiveAgentKind(state.services);
  const installStatus = statusByKind(state.installStatuses, kind);
  const adapter = getAgentAdapter(kind);

  if (!installStatus?.installed) {
    throw new Error(messages.notInstalled(adapter.nameKey));
  }

  const modelSelectionId = adapter.requiresOmniPanelConfig()
    ? resolveAcpModelSelectionId(state.services.find((s) => s.isActive) ?? null)
    : null;

  if (adapter.requiresOmniPanelConfig() && !modelSelectionId) {
    throw new Error(messages.modelRequired);
  }

  const commandLine = adapter.buildLaunchCommand(installStatus);
  if (!commandLine) {
    throw new Error(messages.notLaunchable);
  }

  await connectAgentByKind(kind, installStatus, modelSelectionId);
}
