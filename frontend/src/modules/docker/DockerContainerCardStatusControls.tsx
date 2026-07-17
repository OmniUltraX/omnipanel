import type { MouseEvent } from "react";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import type { ContainerLifecyclePhase, DockerContainerLifecycleAction } from "./dockerContainerLifecycle";
import { PlayIcon, RestartIcon, StopIcon, TrashIcon } from "./icons";

type DockerContainerCardStatusControlsProps = {
  phase: ContainerLifecyclePhase;
  busy: boolean;
  onAction: (action: DockerContainerLifecycleAction, event: MouseEvent<HTMLButtonElement>) => void;
};

function LifecycleSpinner() {
  return (
    <span className="docker-container-card__lifecycle-spinner" aria-hidden>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M8 2a6 6 0 0 1 5.2 9" />
      </svg>
    </span>
  );
}

export function DockerContainerCardStatusControls({
  phase,
  busy,
  onAction,
}: DockerContainerCardStatusControlsProps) {
  const { t } = useI18n();

  if (phase === "transitional" || busy) {
    return (
      <div className="docker-container-card__lifecycle-controls docker-container-card__lifecycle-controls--busy">
        <LifecycleSpinner />
      </div>
    );
  }

  if (phase === "running") {
    return (
      <div className="docker-container-card__lifecycle-controls">
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          className="docker-container-card__lifecycle-btn docker-container-card__lifecycle-btn--danger"
          title={t("docker.dockPanel.stopContainer")}
          aria-label={t("docker.dockPanel.stopContainer")}
          onClick={(event) => onAction("stop", event)}
        >
          <StopIcon />
        </Button>
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          className="docker-container-card__lifecycle-btn docker-container-card__lifecycle-btn--primary"
          title={t("docker.dockPanel.restartContainer")}
          aria-label={t("docker.dockPanel.restartContainer")}
          onClick={(event) => onAction("restart", event)}
        >
          <RestartIcon />
        </Button>
      </div>
    );
  }

  return (
    <div className="docker-container-card__lifecycle-controls">
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className="docker-container-card__lifecycle-btn docker-container-card__lifecycle-btn--start"
        title={t("docker.dockPanel.startContainer")}
        aria-label={t("docker.dockPanel.startContainer")}
        onClick={(event) => onAction("start", event)}
      >
        <PlayIcon />
      </Button>
      <Button
        type="button"
        variant="icon"
        size="icon-xs"
        className="docker-container-card__lifecycle-btn docker-container-card__lifecycle-btn--danger"
        title={t("docker.dockPanel.removeContainer")}
        aria-label={t("docker.dockPanel.removeContainer")}
        onClick={(event) => onAction("remove", event)}
      >
        <TrashIcon />
      </Button>
    </div>
  );
}
