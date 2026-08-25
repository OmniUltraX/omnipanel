/**
 * 登录 / 启动后：若本机无团队同步密钥，尝试中继或打开导入引导对话框。
 */

import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { useAuthStore } from "../../stores/authStore";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";
import { requestTeamSyncKeyFromRelay, SyncKeyRelayError } from "./syncKeyRelayApi";

async function resolveDeviceId(): Promise<string> {
  const identity = await unwrapCommand(commands.authDeviceIdentity(), { quiet: true });
  return identity.deviceId;
}

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

  try {
    const status = await unwrapCommand(commands.syncTeamKeyStatus(teamId), {
      quiet: true,
    });
    if (status.hasKey) {
      authUi.closeDialog();
      return;
    }
  } catch {
    /* 继续尝试中继 */
  }

  try {
    const deviceId = await resolveDeviceId();
    await requestTeamSyncKeyFromRelay({ token, teamId, deviceId, timeoutMs: 45_000 });
    authUi.closeDialog();
    return;
  } catch (e) {
    if (e instanceof SyncKeyRelayError && e.code === "no_online_peer") {
      authUi.openDialog();
      return;
    }
    if (e instanceof SyncKeyRelayError && e.code === "timeout") {
      authUi.openDialog();
      return;
    }
  }

  authUi.openDialog();
}
