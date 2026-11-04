import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import {
  setClientConversationSyncCancelHook,
  setClientConversationSyncHook,
} from "../../lib/clientConversationSyncBridge";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { useAuthStore } from "../../stores/authStore";
import { collectModulesSyncPayload } from "./prepareModulesSyncPayload";
import { scheduleClientModuleSync } from "./moduleSync";
import { withSpaceSyncTask } from "./spaceSyncBackgroundTask";

/** hydrate / applyRemote 期间禁止回推，避免回路 */
let suppressPush = false;

export function setClientConversationSyncSuppressed(value: boolean): void {
  suppressPush = value;
}

/** 取消尚未发出的客户端会话同步（登出时调用）。模块同步自己有取消口。 */
export function cancelClientConversationSync(): void {}

async function pushConversationsOnce(teamId: number | null): Promise<void> {
  await withSpaceSyncTask("push", async () => {
    const token = useAuthStore.getState().token?.trim() ?? "";
    const payload = await collectModulesSyncPayload();
    const report = await unwrapCommand(
      commands.localSpaceSync({
        token,
        teamId,
        sshSidebarTreeJson: payload.sshSidebarTreeJson,
        folderTreesJson: payload.folderTreesJson,
        customPanelsJson: payload.customPanelsJson,
        workspacesJson: payload.workspacesJson,
        conversationsJson: payload.conversationsJson,
        settingsJson: payload.settingsJson,
      }),
      { quiet: true },
    );
    if (!report.skipped) {
      const { applySpaceSyncReport } = await import("./pullCloudSnapshot");
      await applySpaceSyncReport(report);
      const { noticeSpaceSync } = await import("./spaceClaim");
      await noticeSpaceSync(report);
    }
  }, () => "本机变更已同步");
}

/**
 * 会话变更后重写本机检出。已登录时再和团队仓库按路径合并。
 */
export function scheduleClientConversationSync(): void {
  if (suppressPush) return;
  scheduleClientModuleSync();
}

/**
 * 切换团队前把本机会话写回指定团队。不受 suppress 影响。
 */
export async function flushClientConversationSync(
  teamId?: number | null,
): Promise<void> {
  try {
    await pushConversationsOnce(teamId ?? getCurrentSyncTeamId());
  } catch {
    /* 切换前的写入失败不阻断切团队 */
  }
}

// 注册到桥接模块，供 store 侧解耦调用（切断 stores ↔ clientSync 的循环依赖）。
setClientConversationSyncHook(scheduleClientConversationSync);
setClientConversationSyncCancelHook(cancelClientConversationSync);
