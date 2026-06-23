import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import { useDbWorkspace } from "../../contexts/DbWorkspaceContext";
import type { DbConnectionConfig } from "./api";

interface ConnectionResolvedDockPaneProps {
  connId: string;
  className?: string;
  children: (connection: DbConnectionConfig) => ReactNode;
  /** 连接不存在且已加载完成时的回退内容 */
  missingFallback?: ReactNode;
}

/**
 * 按 connId 解析连接并渲染 dock 面板内容。
 * 通过 DbWorkspaceContext 订阅连接列表，避免 dockview contentRev 未 bump 时卡在 loading。
 */
export function ConnectionResolvedDockPane({
  connId,
  className,
  children,
  missingFallback = null,
}: ConnectionResolvedDockPaneProps) {
  const { t } = useI18n();
  const { resolveConnection, connectionsLoading } = useDbWorkspace();
  const connection = resolveConnection(connId);

  if (!connection) {
    if (connectionsLoading) {
      return (
        <div className={className ?? "db-workspace-pane db-dock-pane"}>
          <div className="db-table-designer-state">{t("common.loading")}</div>
        </div>
      );
    }
    return <>{missingFallback}</>;
  }

  return <>{children(connection)}</>;
}
