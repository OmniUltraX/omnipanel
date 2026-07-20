import { SubWindow } from "../ui/window/SubWindow";
import { useUserCenterUiStore } from "../../stores/userCenterUiStore";
import { useI18n } from "../../i18n";
import { UserCenterPanel } from "./UserCenterPanel";
import { selectIsLoggedIn, useAuthStore } from "../../stores/authStore";

export function UserCenterWindow() {
  const { t } = useI18n();
  const open = useUserCenterUiStore((s) => s.open);
  const page = useUserCenterUiStore((s) => s.page);
  const closeUserCenter = useUserCenterUiStore((s) => s.closeUserCenter);
  const isLoggedIn = useAuthStore(selectIsLoggedIn);

  const title = !isLoggedIn
    ? t("userCenter.login.title")
    : page === "subscription"
      ? t("userCenter.nav.subscription")
      : page === "devices"
        ? t("userCenter.nav.devices")
        : t("userCenter.nav.account");

  return (
    <SubWindow
      open={open}
      title={title}
      onClose={closeUserCenter}
      className="user-center-subwindow"
      widthRatio={0.42}
      heightRatio={0.68}
    >
      <UserCenterPanel />
    </SubWindow>
  );
}
