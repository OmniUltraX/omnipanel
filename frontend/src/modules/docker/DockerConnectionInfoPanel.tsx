import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { IconRefresh } from "../../components/ui/Icons";
import { usePersistedModuleTab } from "../../hooks/usePersistedModuleTab";
import { useI18n } from "../../i18n";
import { appConfirm } from "../../lib/appConfirm";
import { appPrompt } from "../../lib/appPrompt";
import {
  commands,
  type DockerConnectionInfo,
  type DockerLocalEngineStatus,
  type DockerProbe,
} from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { showToast } from "../../stores/toastStore";
import { DockerDaemonConfigTabPanel } from "./DockerDaemonConfigTabPanel";
import { DockerDockPanel } from "./DockerDockPanel";
import { DockerHostTerminalPanel } from "./DockerHostTerminalPanel";
import { restartDockerDaemon } from "./dockerDaemonConfigApi";
import { isLocalDockerSource, normalizeDockerSource } from "./dockerConnectionSource";
import { makeDockerTreeKey } from "./dockerResourceLabels";
import { useDockerLiveConnection, useDockerSidebarLinkage } from "./DockerSidebarLinkageContext";

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

const START_POLL_ATTEMPTS = 45;
const START_POLL_INTERVAL_MS = 2000;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export interface DockerConnectionInfoPanelProps {
  connection: DockerConnectionInfo;
  isActive: boolean;
  /** 本地 Engine 启动成功后刷新连接列表（侧栏状态点等） */
  onConnectionsNeedReload?: () => void | Promise<void>;
}

function canManageDockerDaemon(connection: DockerConnectionInfo): boolean {
  return normalizeDockerSource(connection.source) !== "remote-engine";
}

function PanelFallback() {
  return <div className="docker-panel-loading-fallback" aria-hidden />;
}

export function DockerConnectionInfoPanel({
  connection: connectionProp,
  isActive,
  onConnectionsNeedReload,
}: DockerConnectionInfoPanelProps) {
  const { t } = useI18n();
  const { activeNavKey } = useDockerSidebarLinkage();
  // Dock 面板 props 可能滞后；用联动上下文中的最新连接状态
  const connection = useDockerLiveConnection(connectionProp);
  const [subTab, setSubTab] = usePersistedModuleTab(
    `docker-connection-${connection.connectionId}`,
    "containers",
    DETAIL_TABS,
  );
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [startingLocal, setStartingLocal] = useState(false);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [localEngineStatus, setLocalEngineStatus] = useState<DockerLocalEngineStatus | null>(null);
  const [probe, setProbe] = useState<DockerProbe | null>(null);
  const canRestart = canManageDockerDaemon(connection);
  const navAppliedRef = useRef<string | null>(null);
  const onReloadRef = useRef(onConnectionsNeedReload);
  onReloadRef.current = onConnectionsNeedReload;

  const localEngineOnline =
    localEngineStatus?.running === true || probe?.status === "online";
  // connection.status 可能因 Dock 缓存短暂滞后；本地探测已 online 时立即退出启动态
  const showLocalStartGate =
    isLocalDockerSource(connection.source) &&
    connection.status === "offline" &&
    !localEngineOnline;

  const engineVersion = probe?.engineVersion ?? connection.engineVersion;
  const apiVersion = probe?.apiVersion ?? connection.apiVersion;

  const refreshProbe = useCallback(async () => {
    try {
      const next = await unwrapCommand(commands.dockerProbeConnection(connection.connectionId), {
        quiet: true,
      });
      setProbe(next);
    } catch {
      // 探测失败时保留已有版本信息，避免闪烁清空
    }
  }, [connection.connectionId]);

  const refreshLocalEngineStatus = useCallback(async () => {
    try {
      const status = await unwrapCommand(commands.dockerGetLocalEngineStatus(), { quiet: true });
      setLocalEngineStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    setTerminalStarted(false);
    setProbe(null);
    setLocalEngineStatus(null);
    setStartingLocal(false);
  }, [connection.connectionId]);

  useEffect(() => {
    if (subTab === "terminal") {
      setTerminalStarted(true);
    }
  }, [subTab]);

  useEffect(() => {
    if (!isActive) return;
    if (showLocalStartGate) {
      void refreshLocalEngineStatus();
      return;
    }
    void refreshProbe();
  }, [isActive, refreshLocalEngineStatus, refreshProbe, showLocalStartGate]);

  useEffect(() => {
    if (!isActive || showLocalStartGate) return;
    const next = detailTabFromNavKey(connection.connectionId, activeNavKey);
    if (!next) return;
    const signature = `${connection.connectionId}:${activeNavKey}`;
    if (navAppliedRef.current === signature) return;
    navAppliedRef.current = signature;
    setSubTab(next);
  }, [activeNavKey, connection.connectionId, isActive, setSubTab, showLocalStartGate]);

  const handleStartLocalDocker = useCallback(() => {
    if (startingLocal) return;
    void (async () => {
      setStartingLocal(true);
      try {
        await unwrapCommand(commands.dockerStartLocalEngine());
        showToast(t("docker.empty.startingDocker"));
        let online = false;
        for (let i = 0; i < START_POLL_ATTEMPTS; i++) {
          await sleep(START_POLL_INTERVAL_MS);
          const status = await refreshLocalEngineStatus();
          if (status?.running) {
            online = true;
            break;
          }
        }
        await Promise.resolve(onReloadRef.current?.());
        if (online) {
          await refreshProbe();
          showToast(t("docker.empty.startSuccess"));
        } else {
          showToast(t("docker.empty.startFailed"));
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        showToast(
          detail ? `${t("docker.empty.startFailed")}: ${detail}` : t("docker.empty.startFailed"),
        );
      } finally {
        setStartingLocal(false);
      }
    })();
  }, [refreshLocalEngineStatus, refreshProbe, startingLocal, t]);

  const handleRefreshConnectionStatus = useCallback(() => {
    if (statusRefreshing) return;
    void (async () => {
      setStatusRefreshing(true);
      try {
        await Promise.resolve(onReloadRef.current?.());
        if (isLocalDockerSource(connection.source)) {
          await refreshLocalEngineStatus();
        }
        await refreshProbe();
      } finally {
        setStatusRefreshing(false);
      }
    })();
  }, [connection.source, refreshLocalEngineStatus, refreshProbe, statusRefreshing]);

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
        onReloadRef.current?.();
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

  const canStartLocal =
    localEngineStatus == null || localEngineStatus.canStart || localEngineStatus.running;

  return (
    <div className="docker-connection-info-panel">
      <header className="docker-connection-info-header">
        <div className="docker-connection-info-header__text">
          <h2 className="docker-connection-info-header__title">{connection.name}</h2>
          <p className="docker-connection-info-header__subtitle">{connection.hostLabel}</p>
          {!showLocalStartGate && (engineVersion || apiVersion) ? (
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
        <div className="docker-connection-info-header__actions">
          <Button
            type="button"
            variant="icon"
            size="icon-sm"
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
            disabled={statusRefreshing || startingLocal || restartBusy}
            onClick={handleRefreshConnectionStatus}
          >
            <IconRefresh size={14} className={statusRefreshing ? "is-spinning" : undefined} />
          </Button>
          {!showLocalStartGate ? (
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
          ) : null}
        </div>
      </header>

      {showLocalStartGate ? (
        <div className="docker-connection-info-start">
          <p className="docker-connection-info-start__hint">{t("docker.empty.localEngine")}</p>
          {canStartLocal ? (
            <Button
              type="button"
              variant="primary"
              size="default"
              disabled={startingLocal}
              onClick={handleStartLocalDocker}
            >
              {startingLocal ? t("docker.empty.startingDocker") : t("docker.empty.startDocker")}
            </Button>
          ) : (
            <p className="docker-connection-info-start__manual">{t("docker.empty.manualStartHint")}</p>
          )}
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
