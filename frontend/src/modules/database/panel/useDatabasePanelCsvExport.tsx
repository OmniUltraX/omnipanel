import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DbConnectionConfig } from "../api";
import { makeQueryRunId } from "../sql/queryRun";
import { toCsv } from "../shared/csvExport";
import { showToast } from "../../../stores/toastStore";
import {
  createDefaultSqlTabState,
  rowsToRecord,
  type QueryResult,
} from "../workspace/dbWorkspaceState";
import { useDbWorkspaceTabStore } from "../../../stores/dbWorkspaceTabStore";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type CsvExportDialogState = {
  sourceLabel: string;
  baseName: string;
  columns: string[];
  rows: Record<string, unknown>[];
};

export type ExportMenuState = {
  x: number;
  y: number;
  tabId: string;
  sessionId?: string;
};

export type UseDatabasePanelCsvExportDeps = {
  connections: DbConnectionConfig[];
  t: Translate;
};

/** 剪贴板写入：优先 Clipboard API，失败时回退 execCommand。 */
export async function writeToClipboard(text: string): Promise<boolean> {
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === "function") {
    try {
      await clip.writeText(text);
      return true;
    } catch (err) {
      console.error("[clipboard] writeText failed, falling back", err);
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (err) {
    console.error("[clipboard] execCommand failed", err);
  }
  document.body.removeChild(ta);
  return ok;
}

/**
 * CSV / 剪贴板导出切面：解析 Tab 结果 → 打开导出对话框 / 复制 / 导出菜单项。
 * 显式 deps：connections + t。
 */
export function useDatabasePanelCsvExport(deps: UseDatabasePanelCsvExportDeps) {
  const { connections, t } = deps;

  const resolveTabExportData = useCallback(
    async (tabId: string, sessionId?: string) => {
      const { sqlTabStates, tablePreviews } = useDbWorkspaceTabStore.getState();
      const preview = tablePreviews[tabId];

      // 表数据面板：优先导出当前预览页（此前只走 SQL Tab 路径，导致「保存为文件」无反应）
      if (preview?.data && preview.data.columns.length > 0) {
        const baseName =
          preview.dbName && preview.tableName
            ? `${preview.dbName}_${preview.tableName}`
            : preview.tableName || preview.data.name || "table";
        const sourceLabel =
          preview.dbName && preview.tableName
            ? `${preview.dbName}.${preview.tableName}`
            : preview.tableName || preview.data.name || baseName;
        return {
          columns: preview.data.columns,
          rows: preview.data.rows,
          baseName,
          sourceLabel };
      }

      const tabState = sqlTabStates[tabId] ?? createDefaultSqlTabState();
      const connId = preview?.connId ?? sqlTabStates[tabId]?.connId;
      const baseConn = connId ? connections.find((c) => c.id === connId) : null;
      if (!baseConn || !tabState.database.trim()) {
        return null;
      }

      const sessions = tabState.resultSessions ?? [];
      const targetSession = sessionId
        ? sessions.find((item) => item.id === sessionId)
        : sessions.find((item) => item.id === tabState.activeResultSessionId) ??
          sessions[sessions.length - 1];

      if (targetSession?.result && targetSession.result.columns.length > 0) {
        const rows = rowsToRecord(targetSession.result.columns, targetSession.result.rows);
        const baseName = tabState.database.trim()
          ? `${tabState.database}_query`
          : "query";
        return {
          columns: targetSession.result.columns,
          rows,
          baseName,
          sourceLabel: tabState.database.trim() || baseName };
      }

      const conn = { ...baseConn, database: tabState.database };
      if (tabState.sql.trim()) {
        try {
          const queryResult = await invoke<QueryResult>("db_execute_query", {
            connection: conn,
            sql: tabState.sql.trim(),
            runId: makeQueryRunId() });
          if (queryResult.columns.length > 0) {
            const rows = rowsToRecord(queryResult.columns, queryResult.rows);
            const baseName =
              preview?.dbName && preview?.tableName
                ? `${preview.dbName}_${preview.tableName}`
                : tabState.database.trim()
                  ? `${tabState.database}_query`
                  : "query";
            const sourceLabel =
              preview?.dbName && preview?.tableName
                ? `${preview.dbName}.${preview.tableName}`
                : tabState.database.trim() || baseName;
            return { columns: queryResult.columns, rows, baseName, sourceLabel };
          }
        } catch {
          return null;
        }
      }

      return null;
    },
    [connections],
  );

  const [csvExportDialog, setCsvExportDialog] = useState<CsvExportDialogState | null>(null);

  const openCsvExportDialog = useCallback(
    async (tabId: string, sessionId?: string) => {
      try {
        const payload = await resolveTabExportData(tabId, sessionId);
        if (!payload) {
          showToast(t("database.results.exportEmpty"));
          return;
        }
        setCsvExportDialog(payload);
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : t("database.results.exportFailed"),
        );
      }
    },
    [resolveTabExportData, t],
  );

  const copyTabResultToClipboard = useCallback(
    async (tabId: string, sessionId?: string) => {
      try {
        const payload = await resolveTabExportData(tabId, sessionId);
        if (!payload) {
          showToast(t("database.results.exportEmpty"));
          return;
        }
        const ok = await writeToClipboard(toCsv(payload.columns, payload.rows));
        if (ok) {
          showToast(t("common.copied"));
        } else {
          showToast(t("database.results.exportFailed"));
        }
      } catch (err) {
        showToast(
          err instanceof Error
            ? err.message
            : t("database.results.exportFailed"),
        );
      }
    },
    [resolveTabExportData, t],
  );

  const [exportMenu, setExportMenu] = useState<ExportMenuState | null>(null);
  const buildExportMenuItems = useCallback(() => {
    const tabId = exportMenu?.tabId;
    const sessionId = exportMenu?.sessionId;
    const clipboardIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="5" y="5" width="9" height="9" rx="1.5" />
        <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
      </svg>
    );
    const fileIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M3 2.5h7l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
        <path d="M10 2.5V6h3" />
      </svg>
    );
    return [
      {
        id: "export-clipboard",
        label: t("database.results.exportToClipboard"),
        icon: clipboardIcon,
        onClick: () => {
          if (!tabId) return;
          void copyTabResultToClipboard(tabId, sessionId);
        } },
      {
        id: "export-file",
        label: t("database.results.exportToFile"),
        icon: fileIcon,
        onClick: () => {
          if (!tabId) return;
          void openCsvExportDialog(tabId, sessionId);
        } },
    ];
  }, [copyTabResultToClipboard, openCsvExportDialog, exportMenu, t]);

  return {
    csvExportDialog,
    setCsvExportDialog,
    exportMenu,
    setExportMenu,
    openCsvExportDialog,
    copyTabResultToClipboard,
    buildExportMenuItems,
  };
}
