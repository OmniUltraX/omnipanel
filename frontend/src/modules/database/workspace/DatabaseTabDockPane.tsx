import { useSyncExternalStore, useMemo } from "react";
import { DbWorkspaceMirrorProvider } from "../../../contexts/DbWorkspaceContext";
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
import {
  isConnectionInfoTab,
  isDatabaseListTab,
  isSlowQueryLogTab,
  isSqlWorkspaceTab,
  isTableDesignerTab,
  isRedisQueryTab,
  isToolboxTab,
  isTreeChartTab,
} from "./workspaceTabs";
import { DbSchemaProvider, type DbSchemaContextValue } from "../schema/DbSchemaContext";
import { useI18n } from "../../../i18n";

/** 工作区 dock 中数据库 tab 缺少 DbSchemaProvider（仅 DatabasePanel 提供）。
 *  提供空默认值，useTreeChartDatabaseSchema 会回退到 useDbSchemaCacheStore。 */
const EMPTY_SCHEMA_CONTEXT: DbSchemaContextValue = {
  databasesByConnId: {},
  schemaByKey: {},
  schemaLoadingKey: null,
};

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

/** 快照缺失时的 fallback UI：显示提示而非空白 */
function SnapshotMissingFallback({ tabId }: { tabId: string }) {
  const { t } = useI18n();
  return (
    <div className="empty-state compact" style={{ flex: 1, padding: "var(--sp-4)" }}>
      <p style={{ color: "var(--text-muted)", margin: 0 }}>
        {t("common.loading")}
      </p>
      <p style={{ color: "var(--text-muted)", margin: "var(--sp-1) 0 0", fontSize: "12px" }}>
        {tabId}
      </p>
    </div>
  );
}

/** 未支持的 tab kind fallback */
function UnsupportedTabKindFallback({ kind }: { kind: string }) {
  const { t } = useI18n();
  return (
    <div className="empty-state compact" style={{ flex: 1, padding: "var(--sp-4)" }}>
      <p style={{ color: "var(--text-muted)", margin: 0 }}>
        {t("shell.workspacePanel.payloadUnavailable", { module: `database:${kind}` })}
      </p>
    </div>
  );
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
    return <SnapshotMissingFallback tabId={tabId} />;
  }

  const { tab } = snapshot;
  // 用 resolveConnection 替代 groupConnections.find，避免切换分组后找不到连接
  const resolveConn = (connId: string) => overriddenCtx.resolveConnection(connId);

  return (
    <DbSchemaProvider value={EMPTY_SCHEMA_CONTEXT}>
    <DbWorkspaceMirrorProvider value={overriddenCtx}>
      <div className="workspace-database-mirror db-dock-workspace">
        <div className="db-workspace-pane db-dock-pane">
          {isConnectionInfoTab(tab) ? (
            (() => {
              const connection = resolveConn(tab.connId);
              if (!connection) return <SnapshotMissingFallback tabId={tabId} />;
              return <DatabaseConnectionInfoPanel connection={connection} active={_isActive} />;
            })()
          ) : isDatabaseListTab(tab) ? (
            (() => {
              const connection = resolveConn(tab.connId);
              if (!connection) return <SnapshotMissingFallback tabId={tabId} />;
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
              const connection = resolveConn(tab.connId);
              if (!connection) return <SnapshotMissingFallback tabId={tabId} />;
              return (
                <DatabaseSlowQueryLogPanel
                  connection={connection}
                  sshConnectionId={tab.sshConnectionId}
                  logFilePath={tab.logFilePath}
                  deploymentKind={tab.deploymentKind}
                  containerId={tab.containerId}
                  active={_isActive}
                />
              );
            })()
          ) : isSqlWorkspaceTab(tab) ? (
            <DbPanelSurface tab={tab} />
          ) : isTableDesignerTab(tab) ? (
            // 表设计器 tab：暂未在工作区 dock 中提供完整编辑能力，显示提示
            <UnsupportedTabKindFallback kind="designer" />
          ) : isRedisQueryTab(tab) ? (
            <UnsupportedTabKindFallback kind="redis-query" />
          ) : isToolboxTab(tab) ? (
            <UnsupportedTabKindFallback kind="toolbox" />
          ) : isTreeChartTab(tab) ? (
            <UnsupportedTabKindFallback kind="tree-chart" />
          ) : (
            <UnsupportedTabKindFallback kind={tab.kind} />
          )}
        </div>
      </div>
    </DbWorkspaceMirrorProvider>
    </DbSchemaProvider>
  );
}
