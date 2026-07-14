import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import { showToast } from "../../stores/toastStore";
import { DockerContainerLogPanel } from "./DockerContainerLogPanel";
import { DockerDaemonConfigTabPanel } from "./DockerDaemonConfigTabPanel";
import { DockerDockPanel } from "./DockerDockPanel";
import { DockerHostTerminalPanel } from "./DockerHostTerminalPanel";
import { DockerResourceOverviewCards } from "./DockerResourceOverviewCards";
import { restartDockerDaemon } from "./dockerDaemonConfigApi";
import { normalizeDockerSource } from "./dockerConnectionSource";

type ConnectionInfoSubTab = "overview" | "logs" | "terminal" | "config";

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
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const canRestart = canManageDockerDaemon(connection);

  useEffect(() => {
    setSubTab("overview");
    setTerminalStarted(false);
  }, [connection.connectionId]);

  useEffect(() => {
    if (subTab === "terminal") {
      setTerminalStarted(true);
    }
  }, [subTab]);

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

      <DockerResourceOverviewCards connection={connection} isActive={isActive} />

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
          className={`docker-connection-info-tab${subTab === "logs" ? " active" : ""}`}
          aria-selected={subTab === "logs"}
          onClick={() => setSubTab("logs")}
        >
          {t("docker.connectionPanel.tabs.logs")}
        </button>
        <button
          type="button"
          role="tab"
          className={`docker-connection-info-tab${subTab === "terminal" ? " active" : ""}`}
          aria-selected={subTab === "terminal"}
          onClick={() => setSubTab("terminal")}
        >
          {t("docker.connectionPanel.tabs.terminal")}
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

      <div className="docker-connection-info-body">
        {/* 多面板常驻：切换子页签不卸载，避免容器列表 / 日志 / daemon 配置重复拉取 */}
        <div
          className="docker-connection-info-pane"
          role="tabpanel"
          aria-label={t("docker.connectionPanel.tabs.overview")}
          hidden={subTab !== "overview"}
        >
          <DockerDockPanel
            connection={connection}
            isActive={isActive && subTab === "overview"}
            embedded
          />
        </div>
        <div
          className="docker-connection-info-pane"
          role="tabpanel"
          aria-label={t("docker.connectionPanel.tabs.logs")}
          hidden={subTab !== "logs"}
        >
          <DockerContainerLogPanel
            connection={connection}
            isActive={isActive && subTab === "logs"}
          />
        </div>
        <div
          className="docker-connection-info-pane"
          role="tabpanel"
          aria-label={t("docker.connectionPanel.tabs.terminal")}
          hidden={subTab !== "terminal"}
        >
          <DockerHostTerminalPanel
            connection={connection}
            isActive={isActive && terminalStarted}
            visible={subTab === "terminal"}
          />
        </div>
        <div
          className="docker-connection-info-pane"
          role="tabpanel"
          aria-label={t("docker.connectionPanel.tabs.config")}
          hidden={subTab !== "config"}
        >
          <DockerDaemonConfigTabPanel
            connection={connection}
            isActive={isActive && subTab === "config"}
          />
        </div>
      </div>
    </div>
  );
}
