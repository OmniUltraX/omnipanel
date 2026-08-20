/**
 * 登录 / 启动后：若本机无 SyncMasterKey，则打开小程序扫码认证对话框。
 */

import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";

/** 检查本机同步密钥；缺失则打开小程序认证对话框。 */
export async function ensureSyncDeviceAuth(): Promise<void> {
  const token = useAuthStore.getState().token?.trim();
  if (!token) {
    useSyncDeviceAuthStore.getState().reset();
    return;
  }

  const authUi = useSyncDeviceAuthStore.getState();
  if (authUi.dismissedToken === token) return;

  try {
    const status = await unwrapCommand(commands.syncMasterKeyStatus(), {
      quiet: true,
    });
    if (status.hasKey) {
      authUi.closeDialog();
      return;
    }
  } catch {
    /* 继续走认证弹窗 */
  }

  useSyncDeviceAuthStore.getState().openDialog();
}
