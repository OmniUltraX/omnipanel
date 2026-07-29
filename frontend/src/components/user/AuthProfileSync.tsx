import { useEffect, useState } from "react";
import { syncAuthProfile } from "../../lib/auth/syncAuthProfile";
import {
  scheduleAssistantSnapshotSync,
  startAssistantChatInbox,
} from "../../modules/assistant";
import { hydrateClientSync } from "../../modules/clientSync";
import { useAuthStore } from "../../stores/authStore";

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
      // 冷启动已登录：拉取账号级会话 + 各模块（与助手快照独立）
      await hydrateClientSync();
    })();
    // 冷启动已登录：补一次快照，避免助手端长期看不到数据
    scheduleAssistantSnapshotSync();
    void startAssistantChatInbox();
  }, [authHydrated, token]);

  return null;
}
