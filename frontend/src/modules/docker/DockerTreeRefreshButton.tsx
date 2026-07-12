import { Button } from "@/components/ui/Button";
import { useI18n } from "@/i18n";
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
    <Button
      type="button"
      variant="icon"
      size="icon-xs"
      className={`docker-tree-node-action${busy ? " docker-tree-node-action--busy" : ""}`}
      title={t("common.refresh")}
      aria-label={t("common.refresh")}
      disabled={disabled || busy}
      onClick={(event) => {
        event.stopPropagation();
        onRefresh();
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden
      >
        <path d="M2 8a6 6 0 0 1 10.5-3.9" />
        <path d="M14 2v3h-3" />
        <path d="M14 8a6 6 0 0 1-10.5 3.9" />
        <path d="M2 14v-3h3" />
      </svg>
    </Button>
  );
}
