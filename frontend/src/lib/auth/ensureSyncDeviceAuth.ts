/**
 * 登录 / 启动后：若本机无 SyncMasterKey，则打开小程序扫码认证对话框。
 * 旧版 6 位识别码存在时先尝试静默升级，成功则不再弹窗。
 */

import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";
import {
  getDeviceSyncCode,
  isValidDeviceCode,
} from "../../stores/deviceSyncCodeStore";
import { scheduleSecretsVaultSync } from "../../modules/clientSync";

async function tryMigrateLegacyDeviceCode(token: string): Promise<boolean> {
  const legacy = getDeviceSyncCode();
  if (!isValidDeviceCode(legacy)) return false;

  const ossPath = useUserProfileStore.getState().ossPath?.trim() ?? "";
  try {
    await unwrapCommand(commands.secretsVaultUnlock(legacy), { quiet: true });
    if (ossPath) {
      try {
        await unwrapCommand(
          commands.secretsVaultPull({
            token,
            deviceCode: legacy,
            ossPath,
          }),
          { quiet: true },
        );
      } catch {
        /* 云端无旧库 */
      }
    }
    const created = await unwrapCommand(commands.syncMasterKeyGetOrCreate(), {
      quiet: true,
    });
    await unwrapCommand(commands.secretsVaultUnlock(created.key), { quiet: true });
    if (ossPath) {
      try {
        await unwrapCommand(
          commands.secretsVaultPush({
            token,
            deviceCode: created.key,
            ossPath,
          }),
          { quiet: true },
        );
      } catch {
      }
    }
    scheduleSecretsVaultSync();
    return true;
  } catch {
    return false;
  }
}

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

  const migrated = await tryMigrateLegacyDeviceCode(token);
  if (migrated) {
    useSyncDeviceAuthStore.getState().closeDialog();
    return;
  }

  useSyncDeviceAuthStore.getState().openDialog();
}
