import { useSyncExternalStore } from "react";import { DbWorkspaceProvider } from "../../contexts/DbWorkspaceContext";
import {
  getMirroredDbTabSnapshot,
  getMirroredDbTabVersion,
  subscribeMirroredDbTab,
} from "../../stores/dbWorkspaceMirrorStore";
import { DbPanelSurface } from "./DbPanelSurface";
import { DbTablePreviewSurface } from "./DbTablePreviewSurface";
import { isTablePreviewTabId } from "../../stores/dbWorkspaceTabStore";
import { DatabaseConnectionInfoPanel } from "./DatabaseConnectionInfoPanel";
import { DatabaseTablesPanel } from "./DatabaseTablesPanel";
import { isConnectionInfoTab, isDatabaseListTab, isSqlWorkspaceTab } from "./workspaceTabs";
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
  // version 变化时触发重渲染，再读取最新 snapshot
  return version >= 0 ? getMirroredDbTabSnapshot(tabId) : null;
}

/** 数据库模块 dock 与底部工程工作区镜像共用的完整面板 */
export function DatabaseTabDockPane({ tabId, isActive: _isActive }: DatabaseTabDockPaneProps) {
  const snapshot = useMirroredDbTabSnapshot(tabId);

  if (!snapshot) {
    return null;
  }

  const { ctx, tab } = snapshot;

  return (
    <DbWorkspaceProvider value={ctx}>
      <div className="workspace-database-mirror db-dock-workspace">
        <div className="db-workspace-pane db-dock-pane">
          {isConnectionInfoTab(tab) ? (
            (() => {              const connection =
                ctx.groupConnections.find((item) => item.id === tab.connId) ?? null;
              if (!connection) {
                return null;
              }
              return <DatabaseConnectionInfoPanel connection={connection} active={_isActive} />;
            })()
          ) : isDatabaseListTab(tab) ? (
            (() => {
              const connection =
                ctx.groupConnections.find((item) => item.id === tab.connId) ?? null;
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
                />
              );
            })()
          ) : isSqlWorkspaceTab(tab) ? (
            isTablePreviewTabId(tab.id) ? (
              <DbTablePreviewSurface tab={tab} />
            ) : (
              <DbPanelSurface tab={tab} />
            )
          ) : null}
        </div>
      </div>
    </DbWorkspaceProvider>
  );
}
