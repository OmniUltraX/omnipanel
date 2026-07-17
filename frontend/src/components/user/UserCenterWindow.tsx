import { SubWindow } from "../ui/window/SubWindow";
import { useUserCenterUiStore } from "../../stores/userCenterUiStore";
import { useI18n } from "../../i18n";
import { UserCenterPanel } from "./UserCenterPanel";

export function UserCenterWindow() {
  const { t } = useI18n();
  const open = useUserCenterUiStore((s) => s.open);
  const closeUserCenter = useUserCenterUiStore((s) => s.closeUserCenter);

  return (
    <SubWindow
      open={open}
      title={t("userCenter.title")}
      onClose={closeUserCenter}
      className="user-center-subwindow"
      widthRatio={0.42}
      heightRatio={0.72}
    >
      <UserCenterPanel />
    </SubWindow>
  );
}
