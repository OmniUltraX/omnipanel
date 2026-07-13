import { useCallback, useState } from "react";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import { showToast } from "../../stores/toastStore";
import { DockerDaemonConfigTabPanel } from "./DockerDaemonConfigTabPanel";
import { DockerDockPanel } from "./DockerDockPanel";
import { restartDockerDaemon } from "./dockerDaemonConfigApi";
import { normalizeDockerSource } from "./dockerConnectionSource";

type ConnectionInfoSubTab = "overview" | "config";

export interface DockerConnectionInfoPanelProps {
  connection: DockerConnectionInfo;
  isActive: boolean;
}

function canManageDockerDaemon(connection: DockerConnectionInfo): boolean {
  return normalizeDockerSource(connection.source) !== "remote-engine";
}

export function DockerConnectionInfoPanel({
  connection,
  isActive,
}: DockerConnectionInfoPanelProps) {
  const { t } = useI18n();
  const [subTab, setSubTab] = useState<ConnectionInfoSubTab>("overview");
  const [restartBusy, setRestartBusy] = useState(false);
  const canRestart = canManageDockerDaemon(connection);

  const handleRestartDocker = useCallback(() => {
    if (!canRestart || restartBusy) return;
    void (async () => {
      const confirmed = await appConfirm(
        t("docker.connectionPanel.restartConfirm"),
        t("docker.connectionPanel.restartDocker"),
        { kind: "warning", confirmLabel: t("docker.connectionPanel.restartDocker") },
      );
      if (!confirmed) return;

      setRestartBusy(true);
      try {
        await restartDockerDaemon(connection.connectionId);
        showToast(t("docker.connectionPanel.restartSuccess"));
      } catch (e) {
        showToast(
          `${t("docker.connectionPanel.restartFailed")}: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        setRestartBusy(false);
      }
    })();
  }, [canRestart, connection.connectionId, restartBusy, t]);

  return (
    <div className="docker-connection-info-panel">
      <header className="docker-connection-info-header">
        <div className="docker-connection-info-header__text">
          <h2 className="docker-connection-info-header__title">{connection.name}</h2>
          <p className="docker-connection-info-header__subtitle">{connection.hostLabel}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!canRestart || restartBusy}
          onClick={handleRestartDocker}
        >
          {restartBusy
            ? t("docker.connectionPanel.restartingDocker")
            : t("docker.connectionPanel.restartDocker")}
        </Button>
      </header>

      <div className="docker-connection-info-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`docker-connection-info-tab${subTab === "overview" ? " active" : ""}`}
          aria-selected={subTab === "overview"}
          onClick={() => setSubTab("overview")}
        >
          {t("docker.connectionPanel.tabs.overview")}
        </button>
        <button
          type="button"
          role="tab"
          className={`docker-connection-info-tab${subTab === "config" ? " active" : ""}`}
          aria-selected={subTab === "config"}
          onClick={() => setSubTab("config")}
        >
          {t("docker.connectionPanel.tabs.config")}
        </button>
      </div>

      <div
        className="docker-connection-info-body"
        role="tabpanel"
        aria-label={
          subTab === "overview"
            ? t("docker.connectionPanel.tabs.overview")
            : t("docker.connectionPanel.tabs.config")
        }
      >
        {subTab === "overview" ? (
          <DockerDockPanel connection={connection} isActive={isActive} embedded />
        ) : (
          <DockerDaemonConfigTabPanel
            connection={connection}
            isActive={isActive && subTab === "config"}
          />
        )}
      </div>
    </div>
  );
}
