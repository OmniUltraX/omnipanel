import { commands, type PushSnapshotResult } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";

export type { PushSnapshotResult };

export type AssistantPushOptions = {
  dryRun?: boolean;
  bindId?: string | null;
};

/** 推送本机模块元数据快照到 OSS（助手端通道）。 */
export async function pushAssistantSnapshot(
  options: AssistantPushOptions = {},
): Promise<PushSnapshotResult> {
  const token = useAuthStore.getState().token ?? "";
  return unwrapCommand(
    commands.assistantPushSnapshot({
      token,
      dryRun: Boolean(options.dryRun),
      bindId: options.bindId ?? null,
    }),
  );
}
