import { useCallback, type KeyboardEvent } from "react";
import { useI18n } from "../../i18n";
import { selectIsLoggedIn, useAuthStore } from "../../stores/authStore";
import { useUserCenterUiStore } from "../../stores/userCenterUiStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

/** 状态栏最左侧：未登录显示「登录」，已登录显示昵称；点击打开用户中心 */
export function StatusBarUserButton() {
  const { t } = useI18n();
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const openid = useAuthStore((s) => s.openid);
  const nickname = useUserProfileStore((s) => s.nickname);
  const avatarUrl = useUserProfileStore((s) => s.avatarUrl);
  const openUserCenter = useUserCenterUiStore((s) => s.openUserCenter);

  const label = isLoggedIn
    ? nickname.trim() || openid?.slice(0, 8) || t("userCenter.guest")
    : t("userCenter.login.signIn");

  const title = isLoggedIn ? t("userCenter.title") : t("userCenter.login.title");
  const letter = (nickname.trim() || openid || "?").slice(0, 1).toUpperCase();

  const handleOpen = useCallback(() => {
    openUserCenter();
  }, [openUserCenter]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleOpen();
      }
    },
    [handleOpen],
  );

  return (
    <span
      role="button"
      tabIndex={0}
      className="statusbar-item statusbar-user"
      title={title}
      aria-label={title}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
    >
      {isLoggedIn ? (
        <span className="statusbar-user__identity">
          <span className="statusbar-user__avatar" aria-hidden>
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="statusbar-user__avatar-img" />
            ) : (
              letter
            )}
          </span>
          <span className="statusbar-user__name">{label}</span>
        </span>
      ) : (
        label
      )}
    </span>
  );
}
