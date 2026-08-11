import { useEffect, useState } from "react";
import { syncAuthProfile } from "../../lib/auth/syncAuthProfile";
import {
  startPresenceHeartbeat,
  stopPresenceHeartbeat,
} from "../../lib/auth/presenceHeartbeat";
import {
  scheduleAssistantSnapshotSync,
  startAssistantChatInbox,
  startAssistantTerminalCmdInbox,
} from "../../modules/assistant";
import {
  scheduleClientConversationSync,
  scheduleClientModuleSync,
} from "../../modules/clientSync";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

/** 已登录时同步用户资料到 profile store（侧栏头像等依赖）。 */
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
    if (!authHydrated || !token) return;
    void (async () => {
      await syncAuthProfile();
      // 冷启动已登录：上传本机快照（跨端导入改为手动）
      scheduleClientConversationSync({ immediate: true });
      scheduleClientModuleSync({ immediate: true });
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
      return;
    }
    startPresenceHeartbeat({
      getToken: () => useAuthStore.getState().token,
      onAuthExpired: () => {
        useUserProfileStore.getState().clearProfile();
        useAuthStore.getState().logout({ skipRemote: true });
      },
    });
    return () => stopPresenceHeartbeat();
  }, [authHydrated, token]);

  return null;
}
