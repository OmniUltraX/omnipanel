import { Channel } from "@tauri-apps/api/core";
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

/** 通过 Tauri ACP 后端发起一轮 prompt，流式接收 ACP 事件。 */
export async function runAcpPrompt(options: AcpPromptOptions): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("ACP 助手需要在 Tauri 桌面环境中运行");
  }

  const onEvent = new Channel<AcpStreamEvent>();
  onEvent.onmessage = (event) => {
    options.onEvent(event);
  };

  const abortListener = () => {
    void commands.acpCancel(options.conversationId).catch(() => {});
  };
  options.signal?.addEventListener("abort", abortListener);

  try {
    const result = await commands.acpPrompt(
      options.conversationId,
      options.userText,
      options.cwd ?? null,
      onEvent,
    );
    if (result.status === "error") {
      throw new Error(result.error);
    }
  } finally {
    options.signal?.removeEventListener("abort", abortListener);
  }
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

/** @deprecated 使用 connectActiveAcpAgent */
export async function connectDefaultAcpAgent(): Promise<void> {
  await connectActiveAcpAgent();
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

/** 连接当前激活的 Agent（由设置页手动触发）。 */
let connectInFlight: Promise<void> | null = null;

export async function connectActiveAcpAgent(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (connectInFlight) {
    return connectInFlight;
  }

  connectInFlight = (async () => {
    const {
      getActiveAgentKind,
      resolveAcpModelSelectionId,
      useAcpServicesStore,
    } = await import("../../stores/acpServicesStore");

    const state = useAcpServicesStore.getState();
    const kind = getActiveAgentKind(state.services);
    const installStatus = statusByKind(state.installStatuses, kind);
    const adapter = getAgentAdapter(kind);

    if (!installStatus?.installed) {
      console.warn(`[ACP] ${kind} 未安装，跳过 Agent 自动连接`);
      return;
    }

    const modelSelectionId = adapter.requiresOmniPanelConfig()
      ? resolveAcpModelSelectionId(state.services.find((s) => s.isActive) ?? null)
      : null;

    if (adapter.requiresOmniPanelConfig() && !modelSelectionId) {
      console.warn("[ACP] 未配置 AI 模型，跳过 Agent 自动启动");
      return;
    }

    await connectAgentByKind(kind, installStatus, modelSelectionId);
  })().catch((error) => {
    console.warn("[ACP] 启动连接失败:", error);
  }).finally(() => {
    connectInFlight = null;
  });

  return connectInFlight;
}
