/**
 * 密文凭据库自动同步：登录后拉取、模块变更后推送。
 * 依赖本机已有 SyncMasterKey；无密钥时静默跳过（由个人中心完成首台生成 / 配对）。
 */

import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

let inFlight: Promise<void> | null = null;
let pendingAfterFlight = false;
let suppressPush = false;

export function setSecretsVaultSyncSuppressed(value: boolean): void {
  suppressPush = value;
}

async function resolveMasterPassword(): Promise<string | null> {
  try {
    const status = await unwrapCommand(commands.syncMasterKeyStatus(), { quiet: true });
    const key = status.key?.trim();
    if (status.hasKey && key) return key;
  } catch {
  }
  return null;
}

async function pushVaultOnce(): Promise<void> {
  const token = useAuthStore.getState().token?.trim();
  const ossPath = useUserProfileStore.getState().ossPath?.trim();
  if (!token || !ossPath) return;
  const password = await resolveMasterPassword();
  if (!password) return;

  await unwrapCommand(commands.secretsVaultUnlock(password), { quiet: true });
  await unwrapCommand(
    commands.secretsVaultPush({
      token,
      deviceCode: password,
      ossPath,
    }),
    { quiet: true },
  );
  try {
    const { trustSyncDevice } = await import("../../lib/auth/syncPairingApi");
    await trustSyncDevice(token);
  } catch {
  }
}

/**
 * 有 SyncMasterKey 且已登录时，把本机钥匙串凭据加密推到账号 OSS。
 * 与模块自动同步一并触发；无密钥时 no-op。
 */
export function scheduleSecretsVaultSync(): void {
  if (suppressPush) return;
  const token = useAuthStore.getState().token?.trim();
  if (!token) return;
  void runPush();
}

async function runPush(): Promise<void> {
  if (suppressPush) return;
  const token = useAuthStore.getState().token?.trim();
  if (!token) return;

  if (inFlight) {
    pendingAfterFlight = true;
    return;
  }

  inFlight = (async () => {
    try {
      await pushVaultOnce();
    } catch {
    } finally {
      inFlight = null;
      if (pendingAfterFlight) {
        pendingAfterFlight = false;
        scheduleSecretsVaultSync();
      }
    }
  })();

  await inFlight;
}

/** 启动 / 登录后：用本机 SyncMasterKey 从云端拉密文库写回钥匙串。 */
export async function pullSecretsVaultOnce(): Promise<void> {
  const token = useAuthStore.getState().token?.trim();
  if (!token) return;

  let ossPath = useUserProfileStore.getState().ossPath?.trim();
  if (!ossPath) {
    // 资料尚未写入时补一次 /api/me，避免认证刚完成就跳过密文库
    try {
      const { syncAuthProfile } = await import("../../lib/auth/syncAuthProfile");
      await syncAuthProfile();
    } catch {
    }
    ossPath = useUserProfileStore.getState().ossPath?.trim();
  }
  if (!ossPath) {
    console.warn("[client-sync] pullSecretsVaultOnce skipped: missing ossPath");
    return;
  }
  const password = await resolveMasterPassword();
  if (!password) return;

  try {
    await unwrapCommand(
      commands.secretsVaultPull({
        token,
        deviceCode: password,
        ossPath,
      }),
      { quiet: true },
    );
  } catch {
    // 云端尚无库或密钥不匹配时忽略，由后续 push 建立
  }
}
