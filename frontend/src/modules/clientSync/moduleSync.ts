import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import {
  setClientModuleSyncCancelHook,
  setClientModuleSyncHook,
} from "../../lib/clientModuleSyncBridge";
import { useAuthStore } from "../../stores/authStore";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { collectModulesSyncPayload } from "./prepareModulesSyncPayload";
import { scheduleSecretsVaultSync } from "./secretsVaultSync";
import { getSpaceSyncPrefs, noteSpaceSyncFinished } from "./spaceSyncPrefs";

/** 连续修改合成一次，避免每敲一下就整库合并。 */
const AUTO_DEBOUNCE_MS = 3000;

/** 模块同步落到本机后派发，供 Database / Protocol 等面板刷新 */
export const CLIENT_SYNC_MODULES_APPLIED_EVENT = "omnipanel:client-sync-modules-applied";

let inFlight: Promise<void> | null = null;
let pendingAfterFlight = false;
let suppressPush = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function setClientModuleSyncSuppressed(value: boolean): void {
  suppressPush = value;
}

export function cancelClientModuleSync(): void {
  pendingAfterFlight = false;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

async function pushModulesOnce(teamId: number | null): Promise<void> {
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
  noteSpaceSyncFinished();
  const { useSpaceConflictStore } = await import("../../stores/spaceConflictStore");
  void useSpaceConflictStore.getState().refresh();
}

/**
 * 模块数据变更后重写本机检出。已登录时再和团队仓库按路径合并。
 * 同时调度密文库自动推送（有 SyncMasterKey 时生效）。
 */
export function scheduleClientModuleSync(): void {
  if (suppressPush) return;
  if (!getSpaceSyncPrefs().auto) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runPush();
    const token = useAuthStore.getState().token;
    if (token?.trim()) scheduleSecretsVaultSync();
  }, AUTO_DEBOUNCE_MS);
}

async function runPush(): Promise<void> {
  if (suppressPush) return;

  if (inFlight) {
    pendingAfterFlight = true;
    return;
  }

  inFlight = (async () => {
    try {
      await pushModulesOnce(getCurrentSyncTeamId());
    } catch {
    } finally {
      inFlight = null;
      if (pendingAfterFlight) {
        pendingAfterFlight = false;
        scheduleClientModuleSync();
      }
    }
  })();

  await inFlight;
}

/**
 * 强制等待当前推送结束后，再向指定团队推送一份模块快照。
 * 切换团队前用来把本机当前数据写回旧团队；不受 suppress 影响。
 */
export async function flushClientModuleSync(
  teamId?: number | null,
): Promise<void> {
  if (inFlight) {
    try {
      await inFlight;
    } catch {
    }
  }
  pendingAfterFlight = false;
  try {
    await pushModulesOnce(teamId ?? getCurrentSyncTeamId());
  } catch {
  }
}

// 注册到桥接模块，供 store 侧解耦调用（切断 stores ↔ clientSync 的循环依赖）。
setClientModuleSyncHook(scheduleClientModuleSync);
setClientModuleSyncCancelHook(cancelClientModuleSync);
