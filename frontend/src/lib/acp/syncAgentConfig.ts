import { commands } from "../../ipc/bindings";
import { connectAgentByKind } from "../agents/connect";
import { statusByKind } from "../agents/detect";
import { getAgentAdapter } from "../agents/registry";
import { isTauriRuntime } from "../isTauriRuntime";

/** 若当前已启用 ACP 智能体且已连接，则按检测结果重连。 */
export async function syncAndReconnectActiveAcpAgent(): Promise<void> {
  if (!isTauriRuntime()) return;

  const {
    getActiveAgentKind,
    useAcpServicesStore,
  } = await import("../../stores/acpServicesStore");

  const state = useAcpServicesStore.getState();
  const kind = getActiveAgentKind(state.services);
  if (!kind || kind === "opencode") return;

  const installStatus = statusByKind(state.installStatuses, kind);
  if (!installStatus?.installed) return;

  getAgentAdapter(kind);

  const status = await commands.acpGetStatus();
  if (status.status === "ok" && status.data.connected) {
    await connectAgentByKind(kind, installStatus);
  }
}
