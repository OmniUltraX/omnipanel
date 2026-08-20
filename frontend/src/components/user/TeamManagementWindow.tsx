import { SubWindow } from "../ui/window/SubWindow";
import { useTeamManagementUiStore } from "../../stores/teamManagementUiStore";
import { useI18n } from "../../i18n";
import { UserCenterTeams } from "./UserCenterTeams";

/** 独立团队管理弹窗（不再挂在用户中心导航下）。 */
export function TeamManagementWindow() {
  const { t } = useI18n();
  const open = useTeamManagementUiStore((s) => s.open);
  const initialTeamId = useTeamManagementUiStore((s) => s.initialTeamId);
  const closeTeamManagement = useTeamManagementUiStore((s) => s.closeTeamManagement);

  return (
    <SubWindow
      open={open}
      title={t("userCenter.teams.managementTitle")}
      onClose={closeTeamManagement}
      className="team-management-subwindow"
      widthRatio={0.72}
      heightRatio={0.78}
    >
      <div className="team-management-panel">
        <UserCenterTeams initialTeamId={initialTeamId} />
      </div>
    </SubWindow>
  );
}
