import { useEffect, useState } from "react";
import { syncAuthProfile } from "../../lib/auth/syncAuthProfile";
import { scheduleAssistantSnapshotSync } from "../../modules/assistant";
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
    void syncAuthProfile();
    // 冷启动已登录：补一次快照，避免助手端长期看不到数据
    scheduleAssistantSnapshotSync();
  }, [authHydrated, token]);

  return null;
}
