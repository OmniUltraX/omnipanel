import { useEffect, useMemo, useRef } from "react";

import type { DbConnectionConfig } from "../../database/api";
import { useDbConnectionListStore } from "../../../stores/dbConnectionListStore";

/**
 * 自定义面板数据库类小组件：解析 dataSourceId 对应连接。
 * - 启动预热未完成时补 refresh
 * - 已有 id 但列表里找不到时再 refresh 一次（避免 hydrate 空列表后永久 notFound）
 */
export function useDbConnectionForWidget(
  connectionId: string | null,
): {
  connection: DbConnectionConfig | null;
  dbLoaded: boolean;
} {
  const dbConnections = useDbConnectionListStore((s) => s.connections);
  const dbLoaded = useDbConnectionListStore((s) => s.loaded);
  const refreshDbList = useDbConnectionListStore((s) => s.refresh);
  const missingRefreshAttempted = useRef<string | null>(null);

  const connection = useMemo(
    () =>
      connectionId
        ? (dbConnections.find((c) => c.id === connectionId) ?? null)
        : null,
    [connectionId, dbConnections],
  );

  useEffect(() => {
    if (dbLoaded) return;
    void refreshDbList();
  }, [dbLoaded, refreshDbList]);

  useEffect(() => {
    if (!connectionId) return;
    if (connection) {
      missingRefreshAttempted.current = null;
      return;
    }
    if (missingRefreshAttempted.current === connectionId) return;
    missingRefreshAttempted.current = connectionId;
    void refreshDbList();
  }, [connectionId, connection, refreshDbList]);

  return { connection, dbLoaded };
}
