import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { ModuleEmptyState } from "../../components/ui/feedback/ModuleEmptyState";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo, DockerContainerSummary } from "../../ipc/bindings";
import { appConfirm } from "../../lib/appConfirm";
import { DockerContainerExecTerminal } from "./DockerContainerExecTerminal";
import { DockerContainerOverviewCard } from "./DockerContainerOverviewCard";
import { DockerContainerSubWindow } from "./subwindows/DockerContainerSubWindow";
import { DockerContainerLogsView } from "./subwindows/DockerContainerLogsView";
import { DockerContainerSftpPanel } from "./DockerContainerSftpPanel";
import { runDockerContainerAction } from "./dockerContainerActions";
import type { DockerContainerLifecycleAction } from "./dockerContainerLifecycle";
import { containerRowLabel } from "./dockerResourceLabels";
import { useDockerContainerGrid } from "./hooks/useDockerContainerGrid";
import { refreshDockerConnectionSidebarCache } from "./hooks/useDockerConnectionResources";
import type { DockerContainerSubWindowKind } from "./DockerDockPanel";

type OpenContainerSubWindow = {
  containerId: string;
  containerName: string;
  kind: DockerContainerSubWindowKind;
};

export interface DockerContainerDockPanelProps {
  connection: DockerConnectionInfo;
  containerId: string;
  isActive: boolean;
}

function normalizeContainerKey(containerId: string): string {
  return containerId.trim().toLowerCase();
}

function subWindowTitle(kind: DockerContainerSubWindowKind, t: (key: string) => string): string {
  switch (kind) {
    case "detail":
      return t("docker.dockPanel.openDetail");
    case "params":
      return t("docker.dockPanel.params");
    case "logs":
      return t("docker.dockPanel.logs");
    case "directory":
      return t("docker.dockPanel.directory");
  }
}

export function DockerContainerDockPanel({
  connection,
  containerId,
  isActive,
}: DockerContainerDockPanelProps) {
  const { t } = useI18n();
  const { items, loading, error, refreshNow } = useDockerContainerGrid(
    connection.connectionId,
    isActive && connection.status !== "offline",
  );
  const [openSubWindow, setOpenSubWindow] = useState<OpenContainerSubWindow | null>(null);
  const [pendingActions, setPendingActions] = useState<Record<string, true>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const normalizedId = normalizeContainerKey(containerId);

  const gridItem = useMemo(
    () =>
      items.find((item) => {
        const id = normalizeContainerKey(item.container.id);
        const shortId = normalizeContainerKey(item.container.shortId);
        return id === normalizedId || shortId === normalizedId;
      }) ?? null,
    [items, normalizedId],
  );

  const container = gridItem?.container ?? null;
  const stats = gridItem?.stats ?? null;
  const containerName = container ? containerRowLabel(container) : containerId.slice(0, 12);

  const setContainerPending = useCallback((targetId: string, pending: boolean) => {
    const key = normalizeContainerKey(targetId);
    setPendingActions((current) => {
      if (pending) {
        if (current[key]) return current;
        return { ...current, [key]: true };
      }
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const openAction = useCallback(
    (target: DockerContainerSummary, kind: DockerContainerSubWindowKind) => {
      setOpenSubWindow({
        containerId: target.id,
        containerName: containerRowLabel(target),
        kind,
      });
    },
    [],
  );

  const handleLifecycleAction = useCallback(
    (
      target: DockerContainerSummary,
      action: DockerContainerLifecycleAction,
      event: MouseEvent<HTMLButtonElement>,
    ) => {
      event.stopPropagation();
      const name = containerRowLabel(target);
      void (async () => {
        if (action === "remove") {
          const confirmed = await appConfirm(
            t("docker.dockPanel.removeContainerConfirm", { name }),
          );
          if (!confirmed) return;
        }
        setActionError(null);
        setContainerPending(target.id, true);
        try {
          await runDockerContainerAction(connection.connectionId, target.id, action);
          refreshNow();
          refreshDockerConnectionSidebarCache(connection.connectionId);
        } catch (e) {
          setActionError(String(e));
        } finally {
          setContainerPending(target.id, false);
        }
      })();
    },
    [connection.connectionId, refreshNow, setContainerPending, t],
  );

  if (!isActive) {
    return <div className="docker-container-workspace docker-container-workspace--inactive" aria-hidden />;
  }

  return (
    <>
      <div className="docker-container-workspace">
        <div className="docker-container-workspace__header">
          <div>
            <h2 className="docker-container-workspace__title">{containerName}</h2>
            <p className="docker-container-workspace__subtitle">
              {connection.name}
              {connection.hostLabel ? ` · ${connection.hostLabel}` : ""}
            </p>
          </div>
        </div>

        {error || actionError ? (
          <div className="docker-container-workspace__error">{error ?? actionError}</div>
        ) : null}

        {loading && !container ? (
          <div className="docker-container-workspace__loading">{t("docker.dockPanel.loading")}</div>
        ) : !container ? (
          <ModuleEmptyState preset="container" title={t("docker.containerPanel.notFound")} />
        ) : (
          <div className="docker-container-workspace__body">
            <DockLayout direction="horizontal" className="docker-container-workspace__split">
              <DockPanel
                defaultSize="78%"
                minSize="55%"
                maxSize="88%"
                className="docker-container-workspace__exec-pane"
              >
                <DockLayout direction="vertical" className="docker-container-workspace__exec-split">
                  <DockPanel
                    defaultSize="50%"
                    minSize="20%"
                    className="docker-container-workspace__logs-pane"
                  >
                    <DockerContainerLogsView
                      connectionId={connection.connectionId}
                      containerId={container.id}
                      containerName={containerName}
                      visible={isActive}
                    />
                  </DockPanel>
                  <DockHandle direction="vertical" />
                  <DockPanel
                    defaultSize="50%"
                    minSize="20%"
                    className="docker-container-workspace__terminal-pane"
                  >
                    <DockerContainerExecTerminal
                      connection={connection}
                      containerId={container.id}
                      running={container.running}
                      isActive={isActive}
                    />
                  </DockPanel>
                </DockLayout>
              </DockPanel>
              <DockHandle direction="horizontal" />
              <DockPanel defaultSize="22%" minSize="12%" className="docker-container-workspace__side-pane">
                <DockLayout direction="vertical" className="docker-container-workspace__side-split">
                  <DockPanel
                    defaultSize="18%"
                    minSize="12%"
                    maxSize="35%"
                    className="docker-container-workspace__overview-pane"
                  >
                    <div className="docker-container-workspace__overview-wrap">
                      <DockerContainerOverviewCard
                        container={container}
                        stats={stats}
                        t={t}
                        actionPending={Boolean(pendingActions[normalizeContainerKey(container.id)])}
                        onOpenAction={openAction}
                        onLifecycleAction={handleLifecycleAction}
                      />
                    </div>
                  </DockPanel>
                  <DockHandle direction="vertical" />
                  <DockPanel defaultSize="82%" minSize="65%" className="docker-container-workspace__dir-pane">
                    <div className="docker-container-workspace__dir-wrap">
                      <div className="docker-container-workspace__dir-header">
                        {t("docker.dockPanel.directory")}
                      </div>
                      <div className="docker-container-workspace__dir-body">
                        <DockerContainerSftpPanel
                          key={container.id}
                          connectionId={connection.connectionId}
                          containerId={container.id}
                          source={connection.source}
                          className="docker-container-sftp-panel"
                        />
                      </div>
                    </div>
                  </DockPanel>
                </DockLayout>
              </DockPanel>
            </DockLayout>
          </div>
        )}
      </div>

      <DockerContainerSubWindow
        open={openSubWindow != null}
        kind={openSubWindow?.kind ?? "params"}
        title={openSubWindow ? subWindowTitle(openSubWindow.kind, t) : ""}
        containerName={openSubWindow?.containerName ?? ""}
        connectionId={connection.connectionId}
        containerId={openSubWindow?.containerId ?? ""}
        connectionSource={connection.source}
        onClose={() => setOpenSubWindow(null)}
      />
    </>
  );
}
