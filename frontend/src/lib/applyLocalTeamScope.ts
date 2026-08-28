import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { rehydrateTeamFrontend } from "./rehydrateTeamFrontend";
import { getTeamPersistScope, setTeamPersistScope } from "./teamPersist";

export type ApplyLocalTeamScopeResult = {
  teamScope: string;
  /** 目标团队本机目录在打开前没有主库 / 连接 JSON，可安全拉云端快照。 */
  empty: boolean;
};

/**
 * 把本机 SQLite / 连接 JSON 切到 `local` 或数字 teamId，并换前端 persist 桶。
 */
export async function applyLocalTeamScope(
  scope: string,
  opts?: { quiet?: boolean },
): Promise<ApplyLocalTeamScopeResult> {
  const persistBefore = getTeamPersistScope();
  const result = await unwrapCommand(commands.storageSwitchTeam(scope), {
    quiet: opts?.quiet,
  });
  setTeamPersistScope(result.teamScope);
  if (persistBefore !== result.teamScope) {
    await rehydrateTeamFrontend();
  }
  return result;
}

/** 启动时把后端当前团队目录与前端 persist / teamId 对齐。 */
export async function alignLocalStorageTeam(): Promise<ApplyLocalTeamScopeResult> {
  const { useAuthStore } = await import("../stores/authStore");
  const { useCurrentSyncTeamStore, resolveCurrentSyncTeamId } = await import(
    "../stores/currentSyncTeamStore"
  );
  const { useUserProfileStore } = await import("../stores/userProfileStore");

  const token = useAuthStore.getState().token?.trim();
  let scope = "local";
  if (token) {
    const stored = useCurrentSyncTeamStore.getState().teamId;
    const teams = useUserProfileStore.getState().teams;
    const resolved = resolveCurrentSyncTeamId(stored, teams);
    if (stored == null && resolved != null) {
      useCurrentSyncTeamStore.getState().setTeamId(resolved);
    }
    if (resolved && resolved > 0) scope = String(resolved);
  }
  return applyLocalTeamScope(scope, { quiet: true });
}
