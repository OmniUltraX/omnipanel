import { fetchMe, isAuthSessionError } from "./loginApi";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

/**
 * 用当前 token 拉取并写入昵称/头像。
 * 启动与登录后共用，避免仅打开个人中心才有头像。
 */
export async function syncAuthProfile(): Promise<void> {
  const token = useAuthStore.getState().token;
  if (!token) return;

  try {
    const me = await fetchMe(token);
    useUserProfileStore.getState().setProfile({
      nickname: me.nickname,
      avatarUrl: me.avatarUrl,
    });
  } catch (error) {
    if (isAuthSessionError(error)) {
      useUserProfileStore.getState().clearProfile();
      useAuthStore.getState().logout();
    }
  }
}
