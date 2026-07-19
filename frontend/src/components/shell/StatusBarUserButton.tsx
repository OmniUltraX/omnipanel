import { useCallback, type KeyboardEvent } from "react";
import { useI18n } from "../../i18n";
import { selectIsLoggedIn, useAuthStore } from "../../stores/authStore";
import { useUserCenterUiStore } from "../../stores/userCenterUiStore";
import { useUserProfileStore } from "../../stores/userProfileStore";

/** 状态栏最左侧：未登录显示「登录」，已登录显示用户名；点击打开用户中心 */
export function StatusBarUserButton() {
  const { t } = useI18n();
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const openid = useAuthStore((s) => s.openid);
  const displayName = useUserProfileStore((s) => s.displayName);
  const openUserCenter = useUserCenterUiStore((s) => s.openUserCenter);

  const label = isLoggedIn
    ? displayName.trim() || openid?.slice(0, 8) || t("userCenter.guest")
    : t("userCenter.login.signIn");

  const title = isLoggedIn ? t("userCenter.title") : t("userCenter.login.title");

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
      {label}
    </span>
  );
}
