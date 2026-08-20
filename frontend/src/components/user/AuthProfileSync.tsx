import { useEffect, useState } from "react";
import { syncAuthProfile } from "../../lib/auth/syncAuthProfile";
import { ensureSyncDeviceAuth } from "../../lib/auth/ensureSyncDeviceAuth";
import {
  startPresenceHeartbeat,
  stopPresenceHeartbeat,
} from "../../lib/auth/presenceHeartbeat";
import {
  startSyncPairingAutoWrap,
  stopSyncPairingAutoWrap,
} from "../../lib/auth/syncPairingAutoWrap";
import {
  scheduleAssistantSnapshotSync,
  startAssistantChatInbox,
  startAssistantTerminalCmdInbox,
} from "../../modules/assistant";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";

/** 已登录时同步用户资料、云端快照，并在无同步密钥时弹出小程序认证。 */
export function AuthProfileSync() {
  const token = useAuthStore((s) => s.token);
  const [authHydrated, setAuthHydrated] = useState(() => useAuthStore.persist.hasHydrated());

  useEffect(() => {
    if (useAuthStore.persist.hasHydrated()) {
      setAuthHydrated(true);
      return;
    }
    return useAuthStore.persist.onFinishHydration(() => {
      setAuthHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!authHydrated) return;
    if (!token) {
      useSyncDeviceAuthStore.getState().reset();
      return;
    }
    void (async () => {
      await syncAuthProfile();
      try {
        const { pullCloudSnapshot } = await import("../../modules/clientSync");
        await pullCloudSnapshot();
      } catch {
      }
      await ensureSyncDeviceAuth();
    })();
    // 冷启动已登录：补一次快照，避免助手端长期看不到数据
    scheduleAssistantSnapshotSync();
    void startAssistantChatInbox();
    void startAssistantTerminalCmdInbox();
  }, [authHydrated, token]);

  // 登录后维持 Redis presence 心跳；登出 / token 清空时停止
  useEffect(() => {
    if (!authHydrated || !token) {
      stopPresenceHeartbeat();
      stopSyncPairingAutoWrap();
      return;
    }
    startPresenceHeartbeat({
      getToken: () => useAuthStore.getState().token,
      onAuthExpired: () => {
        useUserProfileStore.getState().clearProfile();
        useAuthStore.getState().logout({ skipRemote: true });
      },
    });
    // 本机已有 SyncMasterKey 时自动 wrap 待传钥配对（路径 B/C）
    startSyncPairingAutoWrap({
      getToken: () => useAuthStore.getState().token,
    });
    return () => {
      stopPresenceHeartbeat();
      stopSyncPairingAutoWrap();
    };
  }, [authHydrated, token]);

  return null;
}
