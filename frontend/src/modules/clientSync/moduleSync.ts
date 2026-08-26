import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { collectModulesSyncPayload } from "./prepareModulesSyncPayload";
import { scheduleSecretsVaultSync } from "./secretsVaultSync";

/** 模块同步落到本机后派发，供 Database / Protocol 等面板刷新 */
export const CLIENT_SYNC_MODULES_APPLIED_EVENT = "omnipanel:client-sync-modules-applied";

let inFlight: Promise<void> | null = null;
let pendingAfterFlight = false;
let suppressPush = false;

export function setClientModuleSyncSuppressed(value: boolean): void {
  suppressPush = value;
}

export function cancelClientModuleSync(): void {
  pendingAfterFlight = false;
}

async function pushModulesOnce(teamId: number | null): Promise<void> {
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;
  await unwrapCommand(
    commands.clientSyncPushModules({
      token,
      teamId,
      ...collectModulesSyncPayload(),
    }),
    { quiet: true },
  );
}

/**
 * 模块数据变更后立即推送到当前同步团队 OSS `modules/latest.json`。
 * 同时调度密文库自动推送（有 SyncMasterKey 时生效）。
 */
export function scheduleClientModuleSync(): void {
  if (suppressPush) return;
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

  void runPush();
  scheduleSecretsVaultSync();
}

async function runPush(): Promise<void> {
  if (suppressPush) return;
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

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
