import { fetchMe, isAuthSessionError } from "./loginApi";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

/** 合并并发的资料同步，避免 Bootstrap + AuthProfileSync 各打一次 /api/me。 */
let inflight: Promise<void> | null = null;

/**
 * 用当前 token 拉取并写入昵称/头像。
 * 启动与登录后共用，避免仅打开个人中心才有头像。
 *
 * 网络不可达时静默失败（保留本地缓存资料，不刷 IPC console.error）；
 * 仅会话失效（auth）时清资料并登出。
 */
export async function syncAuthProfile(): Promise<void> {
  const token = useAuthStore.getState().token;
  if (!token) return;

  if (inflight) {
    return inflight;
  }

  inflight = (async () => {
    try {
      const me = await fetchMe(token, { quiet: true });
      useUserProfileStore.getState().setProfile({
        nickname: me.nickname,
        avatarUrl: me.avatarUrl,
        openid: me.openid,
        email: me.email,
        githubId: me.githubId,
      });
    } catch (error) {
      if (isAuthSessionError(error)) {
        useUserProfileStore.getState().clearProfile();
        useAuthStore.getState().logout();
        return;
      }
      // 连接失败等：保留本地 profile，仅在开发时提示一次
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[auth] syncAuthProfile skipped:", message);
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
