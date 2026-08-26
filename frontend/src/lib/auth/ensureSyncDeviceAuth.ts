/**
 * 登录 / 启动后：若本机无团队同步密钥，尝试中继或打开导入引导对话框。
 */

import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { useAuthStore } from "../../stores/authStore";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";
import { ensureTeamSyncKeyForTeam } from "./ensureTeamSyncKey";

/** 检查本机团队同步密钥；缺失则尝试中继或打开引导对话框。 */
export async function ensureSyncDeviceAuth(): Promise<void> {
  const token = useAuthStore.getState().token?.trim();
  if (!token) {
    useSyncDeviceAuthStore.getState().reset();
    return;
  }

  const authUi = useSyncDeviceAuthStore.getState();
  if (authUi.dismissedToken === token) return;

  const teamId = getCurrentSyncTeamId();
  if (!teamId) {
    authUi.openDialog();
    return;
  }

  await ensureTeamSyncKeyForTeam(teamId, { relayTimeoutMs: 45_000 });
}
