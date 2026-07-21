import { useEffect, useState } from "react";
import { syncAuthProfile } from "../../lib/auth/syncAuthProfile";
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
  }, [authHydrated, token]);

  return null;
}
