import type { AcpStreamEvent } from "../../ipc/bindings";
import { commands } from "../../ipc/bindings";
import { connectAgentByKind } from "../agents/connect";
import { getAgentAdapter } from "../agents/registry";
import { statusByKind } from "../agents/detect";
import { isTauriRuntime } from "../isTauriRuntime";

export type { AcpStreamEvent };

export interface AcpPromptOptions {
  conversationId: string;
  userText: string;
  cwd?: string | null;
  signal?: AbortSignal;
  onEvent: (event: AcpStreamEvent) => void;
}

export async function respondAcpPermission(
  requestId: number,
  optionId: string,
): Promise<void> {
  const result = await commands.acpRespondPermission(requestId, optionId);
  if (result.status === "error") {
    throw new Error(result.error);
  }
}

export async function connectAcpAgent(commandLine: string): Promise<void> {
  const result = await commands.acpConnect(commandLine);
  if (result.status === "error") {
    throw new Error(result.error);
  }
}

export async function getAcpDefaultCommand(): Promise<string | null> {
  const result = await commands.acpGetDefaultCommand();
  if (result.status === "error") {
    return null;
  }
  return result.data;
}

export async function getAcpStatus() {
  const result = await commands.acpGetStatus();
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.data;
}

/** 连接当前已启用的 Agent；无一启用则跳过。 */
let connectInFlight: Promise<void> | null = null;

export async function connectActiveAcpAgent(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (connectInFlight) {
    return connectInFlight;
  }

  connectInFlight = (async () => {
    const {
      getActiveAgentKind,
      useAcpServicesStore,
    } = await import("../../stores/acpServicesStore");

    const state = useAcpServicesStore.getState();
    const kind = getActiveAgentKind(state.services);
    if (!kind) {
      console.warn("[ACP] 未启用任何智能体，跳过连接");
      return;
    }
    // OpenCode 走 HTTP serve，不走 ACP 子进程
    if (kind === "opencode") {
      return;
    }

    const installStatus = statusByKind(state.installStatuses, kind);
    getAgentAdapter(kind);

    if (!installStatus?.installed) {
      console.warn(`[ACP] ${kind} 未安装，跳过 Agent 连接`);
      return;
    }

    await connectAgentByKind(kind, installStatus);
  })().catch((error) => {
    console.warn("[ACP] 启动连接失败:", error);
  }).finally(() => {
    connectInFlight = null;
  });

  return connectInFlight;
}
