import { useCallback, useEffect, useState } from "react";
import { useSyncExternalStore } from "react";
import { DbWorkspaceProvider } from "../../contexts/DbWorkspaceContext";
import {
  getDbWorkspaceMirrorContext,
  getMirroredDbTabSnapshot,
  getMirroredDbTabVersion,
  subscribeMirroredDbTab,
} from "../../stores/dbWorkspaceMirrorStore";
import { DbPanelSurface } from "./DbPanelSurface";
import { DbTablePreviewSurface } from "./DbTablePreviewSurface";
import { isTablePreviewTabId } from "../../stores/dbWorkspaceTabStore";
import { DatabaseConnectionInfoPanel } from "./DatabaseConnectionInfoPanel";
import { DatabaseTablesPanel } from "./DatabaseTablesPanel";
import type { SchemaTableSelection } from "./SchemaBrowser";
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
  const [inlineSqlTabId, setInlineSqlTabId] = useState<string | null>(null);

  useEffect(() => {
    setInlineSqlTabId(null);
  }, [tabId]);

  const handleSelectTable = useCallback(
    (selection: SchemaTableSelection) => {
      const ctx = getDbWorkspaceMirrorContext() ?? snapshot?.ctx;
      if (!ctx) return;
      ctx.selectTable(selection);
      queueMicrotask(() => {
        const mirror = getDbWorkspaceMirrorContext();
        const activeId = mirror?.activeTabId;
        const activeTab = mirror?.tabs.find((item) => item.id === activeId);
        if (activeId && activeTab && isSqlWorkspaceTab(activeTab)) {
          setInlineSqlTabId(activeId);
        }
      });
    },
    [snapshot?.ctx],
  );

  if (!snapshot) {
    return null;
  }

  const { ctx, tab } = snapshot;
  const inlineTab =
    inlineSqlTabId != null ? ctx.tabs.find((item) => item.id === inlineSqlTabId) : null;

  return (
    <DbWorkspaceProvider value={ctx}>
      <div className="workspace-database-mirror db-dock-workspace">
        <div className="db-workspace-pane db-dock-pane">
          {inlineTab && isSqlWorkspaceTab(inlineTab) ? (
            isTablePreviewTabId(inlineTab.id) ? (
              <DbTablePreviewSurface tab={inlineTab} />
            ) : (
              <DbPanelSurface tab={inlineTab} />
            )
          ) : isConnectionInfoTab(tab) ? (
            (() => {
              const connection =
                ctx.groupConnections.find((item) => item.id === tab.connId) ?? null;
              if (!connection) {
                return null;
              }
              return <DatabaseConnectionInfoPanel connection={connection} />;
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
                  onSelectTable={handleSelectTable}
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
