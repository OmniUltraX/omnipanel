import { commands } from "../../ipc/bindings";
import { connectAgentByKind } from "../agents/connect";
import { statusByKind } from "../agents/detect";
import { getAgentAdapter } from "../agents/registry";
import {
  resolveModelSelection,
  useAiModelsStore,
} from "../../stores/aiModelsStore";
import { isTauriRuntime } from "../isTauriRuntime";

let syncInFlight: Promise<void> | null = null;
let syncInFlightKey: string | null = null;

/** 将当前模型选择解析并写入 acp-agent-config.json（仅需要 OmniPanel 配置的 Agent 使用）。 */
export async function syncAcpAgentConfigFile(
  modelSelectionId: string,
): Promise<void> {
  if (!isTauriRuntime()) return;

  if (syncInFlight && syncInFlightKey === modelSelectionId) {
    return syncInFlight;
  }

  syncInFlightKey = modelSelectionId;
  syncInFlight = (async () => {
    const providers = useAiModelsStore.getState().providers;
    const resolved = resolveModelSelection(providers, modelSelectionId);
    if (!resolved) {
      throw new Error("所选模型无效或已禁用，请先在「设置 → AI 模型」中配置");
    }
    if (!resolved.apiKey.trim()) {
      throw new Error("所选模型的 API Key 为空，请先在「设置 → AI 模型」中填写");
    }

    const result = await commands.acpSaveAgentConfig({
      model: resolved.name,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      apiStandard: resolved.apiStandard,
    });

    if (result.status === "error") {
      throw new Error(result.error);
    }
  })();

  try {
    await syncInFlight;
  } finally {
    syncInFlight = null;
    syncInFlightKey = null;
  }
}

/** 同步当前 Agent 配置并在已连接时重连 Agent。 */
export async function syncAndReconnectActiveAcpAgent(): Promise<void> {
  if (!isTauriRuntime()) return;

  const {
    getActiveAgentKind,
    resolveAcpModelSelectionId,
    useAcpServicesStore,
  } = await import("../../stores/acpServicesStore");

  const state = useAcpServicesStore.getState();
  const kind = getActiveAgentKind(state.services);
  const installStatus = statusByKind(state.installStatuses, kind);
  if (!installStatus?.installed) return;

  const adapter = getAgentAdapter(kind);
  const modelSelectionId = adapter.requiresOmniPanelConfig()
    ? resolveAcpModelSelectionId(state.services.find((s) => s.isActive) ?? null)
    : null;

  if (adapter.requiresOmniPanelConfig() && modelSelectionId) {
    await syncAcpAgentConfigFile(modelSelectionId);
  }

  const status = await commands.acpGetStatus();
  if (status.status === "ok" && status.data.connected) {
    await connectAgentByKind(kind, installStatus, modelSelectionId);
  }
}
