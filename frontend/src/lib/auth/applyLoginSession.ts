import { fetchMe } from "./loginApi";
import { hydrateCloudAfterLogin } from "./hydrateCloudAfterLogin";
import { useAuthStore } from "../../stores/authStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

/**
 * 登录成功：写入会话 → 拉资料 → 后台对齐团队目录并拉云端快照。
 * LoginPage / 个人中心 / 微信扫码共用；与 Bootstrap splash 的 hydrate 会合并并发。
 */
export async function applyLoginSession(token: string, openid: string): Promise<void> {
  useAuthStore.getState().setSession({ token, openid });
  try {
    const me = await fetchMe(token);
    useUserProfileStore.getState().setProfile({
      nickname: me.nickname,
      avatarUrl: me.avatarUrl,
      openid: me.openid,
      email: me.email,
      githubId: me.githubId,
      ossPath: me.ossPath,
      teams: me.teams,
    });
  } catch {
    const profile = useUserProfileStore.getState();
    if (!profile.nickname.trim() && openid) {
      profile.setNickname(openid.slice(0, 8));
    }
  }
  // 不阻塞登录 UI：资料已写入后即可拉云端；splash / AuthProfileSync 会 await 同一 inflight
  void hydrateCloudAfterLogin();
}
