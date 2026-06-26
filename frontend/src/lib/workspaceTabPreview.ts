import type { WorkspaceDockTab } from "../stores/workspaceBottomDockStore";
import { getMirroredDbTabSnapshot } from "../stores/dbWorkspaceMirrorStore";
import { useTerminalStore } from "../stores/terminalStore";
import { getDockerLogPreview, dockerPreviewKey } from "../stores/workspacePreviewStore";
import type { WorkspaceTabSnapshot } from "../stores/workspaceTabStore";
import { resolveMockWorkspaceTabPreview } from "./workspacePreviewMockPanels";
import { resolveWorkspaceComponentPreviewKind } from "./workspaceComponentRegistry";
import { isComponentSnapshot } from "./workspaceComponentTypes";

export type WorkspacePreviewKind =
  | "terminal"
  | "database-sql"
  | "database-table"
  | "docker-logs"
  | "docker-terminal"
  | "board"
  | "ai"
  | "fallback";

export interface WorkspaceTabPreviewData {
  kind: WorkspacePreviewKind;
  title: string;
  source: string;
  status?: string;
  lines: string[];
}

/** task-bar 等 UI 展示用：去掉 Ctrl+复制写入的「(副本)」后缀 */
export function stripWorkspaceTabCopySuffix(title: string): string {
  const stripped = title.replace(/\s*[（(]副本[)）]\s*$/u, "").trim();
  return stripped || title;
}

function terminalBufferLines(terminalTabId: string, maxLines = 6): string[] {
  const tab = useTerminalStore.getState().tabs.find((item) => item.id === terminalTabId);
  const term = tab?.terminal;
  if (!term) {
    if (tab) {
      return [`${tab.session.shellLabel} · ${tab.status}`];
    }
    return [];
  }
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.length - maxLines);
  const lines: string[] = [];
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.getLine(i)?.translateToString(true) ?? "";
    if (line.trim()) lines.push(line);
  }
  return lines.length > 0 ? lines : ["(空终端)"];
}

function dbPreviewLines(tabId: string): WorkspaceTabPreviewData | null {
  const snapshot = getMirroredDbTabSnapshot(tabId);
  if (!snapshot) return null;
  const { tab, ctx } = snapshot;
  const sqlState = ctx.sqlTabStates[tabId];
  if (tab.kind === "sql" || ctx.tabModes[tabId] === "sql") {
    const sql = sqlState?.sql?.trim();
    const preview = sql
      ? sql.split("\n").slice(0, 4)
      : ["SELECT …"];
    if (sqlState?.running) preview.push("执行中…");
    if (sqlState?.error) preview.push(sqlState.error);
    const activeSession =
      sqlState?.resultSessions?.find(
        (item) => item.id === sqlState.activeResultSessionId,
      ) ?? sqlState?.resultSessions?.[sqlState.resultSessions.length - 1];
    if (activeSession?.result?.columns?.length) {
      preview.push(activeSession.result.columns.join(" | "));
      const row = activeSession.result.rows[0];
      if (row) preview.push(row.map(String).join(" | "));
    }
    return {
      kind: "database-sql",
      title: tab.label,
      source: "数据库",
      status: sqlState?.running ? "running" : undefined,
      lines: preview,
    };
  }
  const tablePreview = ctx.tablePreviews[tabId];
  const connName = tablePreview?.connId
    ? ctx.resolveConnection(tablePreview.connId)?.name
    : null;
  const lines = [
    connName ?? "未连接",
    tablePreview?.dbName ? `库: ${tablePreview.dbName}` : "",
    tablePreview?.tableName ? `表: ${tablePreview.tableName}` : "",
  ].filter(Boolean);
  return {
    kind: "database-table",
    title: tab.label,
    source: "数据库",
    lines: lines.length > 0 ? lines : [tab.label],
  };
}

function payloadPreview(payload: WorkspaceTabSnapshot): WorkspaceTabPreviewData {
  if (payload.module === "terminal") {
    return {
      kind: "terminal",
      title: payload.label,
      source: "终端",
      lines: terminalBufferLines(payload.id),
    };
  }
  if (payload.module === "database") {
    const db = dbPreviewLines(payload.id);
    if (db) return db;
    return {
      kind: "database-sql",
      title: payload.label,
      source: "数据库",
      lines: [payload.tab.label],
    };
  }
  if (payload.module === "docker") {
    const key = dockerPreviewKey(payload.connectionId, payload.containerId);
    const logs = getDockerLogPreview(key);
    if (payload.subTab === "terminal") {
      return {
        kind: "docker-terminal",
        title: payload.containerName || payload.label,
        source: "Docker",
        status: "exec",
        lines: [`容器: ${payload.containerName}`, `ID: ${payload.containerId.slice(0, 12)}`],
      };
    }
    const logLines = logs
      ? logs.split("\n").filter(Boolean).slice(-4)
      : [`容器: ${payload.containerName}`, "等待日志…"];
    return {
      kind: "docker-logs",
      title: payload.containerName || payload.label,
      source: "Docker",
      lines: logLines,
    };
  }
  if (payload.module === "route") {
    return {
      kind: "fallback",
      title: payload.label,
      source: payload.label.split(" · ")[0] ?? "模块",
      lines: [payload.path],
    };
  }
  if (payload.module === "component" || isComponentSnapshot(payload)) {
    return {
      kind: resolveWorkspaceComponentPreviewKind(payload.componentType),
      title: payload.label,
      source: payload.componentType,
      lines: [payload.label],
    };
  }
  const _exhaustive: never = payload;
  return fallbackPreview(String(_exhaustive), "快照");
}

function fallbackPreview(title: string, source: string): WorkspaceTabPreviewData {
  return { kind: "fallback", title, source, lines: [title] };
}

/** 根据工作区 Tab 元数据解析缩略图预览（带降级） */
export function resolveWorkspaceTabPreview(tab: WorkspaceDockTab): WorkspaceTabPreviewData {
  if (tab.id.startsWith("ws-preview-mock:")) {
    const mock = resolveMockWorkspaceTabPreview(tab.id);
    if (mock) return mock;
  }
  if (tab.kind === "payload" && tab.payload) {
    return payloadPreview(tab.payload);
  }
  if (tab.originScope === "terminal" && tab.originPanelId) {
    const live = useTerminalStore.getState().tabs.find((t) => t.id === tab.originPanelId);
    return {
      kind: "terminal",
      title: tab.label,
      source: "终端",
      status: live?.status,
      lines: terminalBufferLines(tab.originPanelId),
    };
  }
  if (tab.originScope === "database" && tab.originPanelId) {
    const db = dbPreviewLines(tab.originPanelId);
    if (db) return db;
  }
  if (tab.originScope === "docker" && tab.payload?.module === "docker") {
    return payloadPreview(tab.payload);
  }
  return fallbackPreview(tab.label, tab.originScope ?? "工作区");
}
