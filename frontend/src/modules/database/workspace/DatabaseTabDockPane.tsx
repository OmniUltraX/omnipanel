import { useSyncExternalStore, useMemo } from "react";
import { DbWorkspaceProvider } from "../../../contexts/DbWorkspaceContext";
import {
  getMirroredDbTabSnapshot,
  getMirroredDbTabVersion,
  subscribeMirroredDbTab,
} from "../../../stores/dbWorkspaceMirrorStore";
import { DbPanelSurface } from "./DbPanelSurface";
import { DbTablePreviewSurface } from "./DbTablePreviewSurface";
import { isTablePreviewTab } from "../../../stores/dbWorkspaceTabStore";
import { DatabaseConnectionInfoPanel } from "./DatabaseConnectionInfoPanel";
import { DatabaseSlowQueryLogPanel } from "./DatabaseSlowQueryLogPanel";
import { DatabaseTablesPanel } from "./DatabaseTablesPanel";
import { isConnectionInfoTab, isDatabaseListTab, isSlowQueryLogTab, isSqlWorkspaceTab } from "./workspaceTabs";

interface DatabaseTabDockPaneProps {
  tabId: string;
  isActive: boolean;
}

function useMirroredDbTabSnapshot(tabId: string) {
  const version = useSyncExternalStore(
    (listener) => subscribeMirroredDbTab(tabId, listener),
    () => getMirroredDbTabVersion(tabId),
    () => 0,
  );
  return version >= 0 ? getMirroredDbTabSnapshot(tabId) : null;
}

/** 数据库模块 dock 与底部工程工作区镜像共用的完整面板 */
export function DatabaseTabDockPane({ tabId, isActive: _isActive }: DatabaseTabDockPaneProps) {
  const snapshot = useMirroredDbTabSnapshot(tabId);

  const overriddenCtx = useMemo(() => {
    if (!snapshot) return null;
    return {
      ...snapshot.ctx,
      activeTabId: _isActive ? tabId : "",
    };
  }, [snapshot, _isActive, tabId]);

  if (!snapshot || !overriddenCtx) {
    return null;
  }

  const { tab } = snapshot;

  return (
    <DbWorkspaceProvider value={overriddenCtx}>
      <div className="workspace-database-mirror db-dock-workspace">
        <div className="db-workspace-pane db-dock-pane">
          {isConnectionInfoTab(tab) ? (
            (() => {
              const connection =
                overriddenCtx.groupConnections.find((item) => item.id === tab.connId) ?? null;
              if (!connection) {
                return null;
              }
              return <DatabaseConnectionInfoPanel connection={connection} active={_isActive} />;
            })()
          ) : isDatabaseListTab(tab) ? (
            (() => {
              const connection =
                overriddenCtx.groupConnections.find((item) => item.id === tab.connId) ?? null;
              if (!connection) {
                return null;
              }
              return (
                <DatabaseTablesPanel
                  selection={{
                    connId: tab.connId,
                    dbName: tab.dbName,
                    connection,
                  }}
                  onDesignTable={overriddenCtx.openTableDesigner}
                  onOpenTableData={overriddenCtx.selectTable}
                />
              );
            })()
          ) : isTablePreviewTab(tab) ? (
            <DbTablePreviewSurface tab={tab} />
          ) : isSlowQueryLogTab(tab) ? (
            (() => {
              const connection =
                overriddenCtx.groupConnections.find((item) => item.id === tab.connId) ?? null;
              if (!connection) {
                return null;
              }
              return (
                <DatabaseSlowQueryLogPanel
                  connection={connection}
                  sshConnectionId={tab.sshConnectionId}
                  logFilePath={tab.logFilePath}
                  active={_isActive}
                />
              );
            })()
          ) : isSqlWorkspaceTab(tab) ? (
            <DbPanelSurface tab={tab} />
          ) : null}
        </div>
      </div>
    </DbWorkspaceProvider>
  );
}
