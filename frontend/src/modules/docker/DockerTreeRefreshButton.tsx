import { useI18n } from "@/i18n";
import { SidebarRefreshIcon } from "@/components/ui/module-sidebar";
import { useDockerSidebarRefreshing } from "./hooks/useDockerConnectionResources";

type DockerTreeRefreshButtonProps = {
  refreshKey: string;
  disabled?: boolean;
  onRefresh: () => void;
};

export function DockerTreeRefreshButton({
  refreshKey,
  disabled = false,
  onRefresh,
}: DockerTreeRefreshButtonProps) {
  const { t } = useI18n();
  const busy = useDockerSidebarRefreshing(refreshKey);
  return (
    <button
      type="button"
      className={`tree-action-btn${busy ? " tree-action-btn--busy" : ""}`}
      title={t("common.refresh")}
      aria-label={t("common.refresh")}
      disabled={disabled || busy}
      onClick={(event) => {
        event.stopPropagation();
        onRefresh();
      }}
    >
      <SidebarRefreshIcon />
    </button>
  );
}
