import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { appPrompt } from "../../lib/appPrompt";
import { commands, type DockerConnectionInfo, type DockerProbe } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { showToast } from "../../stores/toastStore";
import { DockerDaemonConfigTabPanel } from "./DockerDaemonConfigTabPanel";
import { DockerDockPanel } from "./DockerDockPanel";
import { DockerHostTerminalPanel } from "./DockerHostTerminalPanel";
import { restartDockerDaemon } from "./dockerDaemonConfigApi";
import { normalizeDockerSource } from "./dockerConnectionSource";
import { makeDockerTreeKey } from "./dockerResourceLabels";
import { useDockerSidebarLinkage } from "./DockerSidebarLinkageContext";

const DockerImagePanel = lazy(() =>
  import("./DockerImagePanel").then((mod) => ({ default: mod.DockerImagePanel })),
);
const DockerNetworkPanel = lazy(() =>
  import("./DockerNetworkPanel").then((mod) => ({ default: mod.DockerNetworkPanel })),
);
const DockerVolumePanel = lazy(() =>
  import("./DockerVolumePanel").then((mod) => ({ default: mod.DockerVolumePanel })),
);

export type ConnectionInfoSubTab =
  | "containers"
  | "terminal"
  | "config"
  | "images"
  | "networks"
  | "volumes";

/** 二次确认后仍须在输入框原样输入该词，才真正执行重启 */
const RESTART_CONFIRM_TOKEN = "RESTART";

const DETAIL_TABS: readonly ConnectionInfoSubTab[] = [
  "containers",
  "images",
  "networks",
  "volumes",
  "terminal",
  "config",
];

function detailTabFromNavKey(
  connectionId: string,
  navKey: string | null,
): ConnectionInfoSubTab | null {
  if (!navKey) return null;
  if (navKey === makeDockerTreeKey(connectionId, "containers")) return "containers";
  if (navKey === makeDockerTreeKey(connectionId, "images")) return "images";
  if (navKey === makeDockerTreeKey(connectionId, "networks")) return "networks";
  if (navKey === makeDockerTreeKey(connectionId, "volumes")) return "volumes";
  return null;
}

function tabLabel(
  tab: ConnectionInfoSubTab,
  t: (key: string) => string,
): string {
  if (tab === "terminal" || tab === "config") {
    return t(`docker.connectionPanel.tabs.${tab}`);
  }
  return t(`docker.tabs.${tab}`);
}

export interface DockerConnectionInfoPanelProps {
  connection: DockerConnectionInfo;
  isActive: boolean;
}

function canManageDockerDaemon(connection: DockerConnectionInfo): boolean {
  return normalizeDockerSource(connection.source) !== "remote-engine";
}

function PanelFallback() {
  return <div className="docker-panel-loading-fallback" aria-hidden />;
}

export function DockerConnectionInfoPanel({
  connection,
  isActive,
}: DockerConnectionInfoPanelProps) {
  const { t } = useI18n();
  const { activeNavKey } = useDockerSidebarLinkage();
  const [subTab, setSubTab] = usePersistedModuleTab(
    `docker-connection-${connection.connectionId}`,
    "containers",
    DETAIL_TABS,
  );
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [probe, setProbe] = useState<DockerProbe | null>(null);
  const canRestart = canManageDockerDaemon(connection);
  const navAppliedRef = useRef<string | null>(null);

  const engineVersion = probe?.engineVersion ?? connection.engineVersion;
  const apiVersion = probe?.apiVersion ?? connection.apiVersion;

  const refreshProbe = useCallback(async () => {
    try {
      const next = await unwrapCommand(commands.dockerProbeConnection(connection.connectionId));
      setProbe(next);
    } catch {
      // 探测失败时保留已有版本信息，避免闪烁清空
    }
  }, [connection.connectionId]);

  useEffect(() => {
    setTerminalStarted(false);
    setProbe(null);
  }, [connection.connectionId]);

  useEffect(() => {
    if (subTab === "terminal") {
      setTerminalStarted(true);
    }
  }, [subTab]);

  useEffect(() => {
    if (!isActive) return;
    void refreshProbe();
  }, [isActive, refreshProbe]);

  useEffect(() => {
    if (!isActive) return;
    const next = detailTabFromNavKey(connection.connectionId, activeNavKey);
    if (!next) return;
    const signature = `${connection.connectionId}:${activeNavKey}`;
    if (navAppliedRef.current === signature) return;
    navAppliedRef.current = signature;
    setSubTab(next);
  }, [activeNavKey, connection.connectionId, isActive, setSubTab]);

  const handleRestartDocker = useCallback(() => {
    if (!canRestart || restartBusy) return;
    void (async () => {
      const target = connection.name || connection.hostLabel || connection.connectionId;

      const firstOk = await appConfirm(
        t("docker.connectionPanel.restartConfirmMessage", { target }),
        t("docker.connectionPanel.restartConfirmTitle"),
        {
          confirmLabel: t("docker.connectionPanel.restartConfirmContinue"),
        },
      );
      if (!firstOk) return;

      const secondOk = await appConfirm(
        t("docker.connectionPanel.restartConfirmMessage2", { target }),
        t("docker.connectionPanel.restartConfirmTitle2"),
        {
          confirmLabel: t("docker.connectionPanel.restartConfirmContinue2"),
        },
      );
      if (!secondOk) return;

      const typed = await appPrompt(
        t("docker.connectionPanel.restartTypePrompt", {
          token: RESTART_CONFIRM_TOKEN,
          target,
        }),
        "",
        t("docker.connectionPanel.restartTypeTitle"),
      );
      if (typed == null) return;
      if (typed.trim() !== RESTART_CONFIRM_TOKEN) {
        showToast(t("docker.connectionPanel.restartTypeMismatch"));
        return;
      }

      setRestartBusy(true);
      try {
        await restartDockerDaemon(connection.connectionId);
        showToast(t("docker.connectionPanel.restartSuccess"));
        await refreshProbe();
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        showToast(
          detail
            ? `${t("docker.connectionPanel.restartFailed")}: ${detail}`
            : t("docker.connectionPanel.restartFailed"),
        );
      } finally {
        setRestartBusy(false);
      }
    })();
  }, [
    canRestart,
    connection.connectionId,
    connection.hostLabel,
    connection.name,
    refreshProbe,
    restartBusy,
    t,
  ]);

  return (
    <div className="docker-connection-info-panel">
      <header className="docker-connection-info-header">
        <div className="docker-connection-info-header__text">
          <h2 className="docker-connection-info-header__title">{connection.name}</h2>
          <p className="docker-connection-info-header__subtitle">{connection.hostLabel}</p>
          {engineVersion || apiVersion ? (
            <div className="docker-connection-info-header__tags">
              {engineVersion ? (
                <span
                  className="tag"
                  title={t("docker.connectionPanel.engineVersion", { version: engineVersion })}
                >
                  {t("docker.connectionPanel.engineVersion", { version: engineVersion })}
                </span>
              ) : null}
              {apiVersion ? (
                <span
                  className="tag"
                  title={t("docker.connectionPanel.apiVersion", { version: apiVersion })}
                >
                  {t("docker.connectionPanel.apiVersion", { version: apiVersion })}
                </span>
              ) : null}
            </div>
          ) : null}
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
        {DETAIL_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            className={`docker-connection-info-tab${subTab === tab ? " active" : ""}`}
            aria-selected={subTab === tab}
            onClick={() => setSubTab(tab)}
          >
            {tabLabel(tab, t)}
          </button>
        ))}
      </div>

      <div className="docker-connection-info-body">
        {/* 多面板常驻：切换子页签不卸载，避免资源列表 / 配置重复拉取 */}
        <div
          className="docker-connection-info-pane"
          role="tabpanel"
          aria-label={tabLabel("containers", t)}
          hidden={subTab !== "containers"}
        >
          <DockerDockPanel
            connection={connection}
            isActive={isActive && subTab === "containers"}
            embedded
          />
        </div>
        <div
          className="docker-connection-info-pane docker-connection-info-pane--resource"
          role="tabpanel"
          aria-label={tabLabel("images", t)}
          hidden={subTab !== "images"}
        >
          <Suspense fallback={<PanelFallback />}>
            <DockerImagePanel connection={connection} isActive={isActive && subTab === "images"} />
          </Suspense>
        </div>
        <div
          className="docker-connection-info-pane docker-connection-info-pane--resource"
          role="tabpanel"
          aria-label={tabLabel("networks", t)}
          hidden={subTab !== "networks"}
        >
          <Suspense fallback={<PanelFallback />}>
            <DockerNetworkPanel
              connection={connection}
              isActive={isActive && subTab === "networks"}
            />
          </Suspense>
        </div>
        <div
          className="docker-connection-info-pane docker-connection-info-pane--resource"
          role="tabpanel"
          aria-label={tabLabel("volumes", t)}
          hidden={subTab !== "volumes"}
        >
          <Suspense fallback={<PanelFallback />}>
            <DockerVolumePanel
              connection={connection}
              isActive={isActive && subTab === "volumes"}
            />
          </Suspense>
        </div>
        <div
          className="docker-connection-info-pane"
          role="tabpanel"
          aria-label={tabLabel("terminal", t)}
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
          aria-label={tabLabel("config", t)}
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
