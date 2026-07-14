import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import type { DockerContainerViewMode } from "./usePersistedDockerContainerViewMode";

type DockerContainerViewModeToggleProps = {
  mode: DockerContainerViewMode;
  onChange: (mode: DockerContainerViewMode) => void;
};

function GridViewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="2" y="2" width="5" height="5" rx="0.8" />
      <rect x="9" y="2" width="5" height="5" rx="0.8" />
      <rect x="2" y="9" width="5" height="5" rx="0.8" />
      <rect x="9" y="9" width="5" height="5" rx="0.8" />
    </svg>
  );
}

function TableViewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M2 6h12M2 9.5h12M6.5 6v7.5" />
    </svg>
  );
}

export function DockerContainerViewModeToggle({ mode, onChange }: DockerContainerViewModeToggleProps) {
  const { t } = useI18n();
  return (
    <div className="docker-dock-panel__view-toggle" role="group" aria-label={t("docker.dockPanel.viewMode")}>
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className={`docker-dock-panel__view-btn${mode === "grid" ? " is-active" : ""}`}
        title={t("docker.dockPanel.viewGrid")}
        aria-label={t("docker.dockPanel.viewGrid")}
        aria-pressed={mode === "grid"}
        onClick={() => onChange("grid")}
      >
        <GridViewIcon />
      </Button>
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className={`docker-dock-panel__view-btn${mode === "table" ? " is-active" : ""}`}
        title={t("docker.dockPanel.viewTable")}
        aria-label={t("docker.dockPanel.viewTable")}
        aria-pressed={mode === "table"}
        onClick={() => onChange("table")}
      >
        <TableViewIcon />
      </Button>
    </div>
  );
}
