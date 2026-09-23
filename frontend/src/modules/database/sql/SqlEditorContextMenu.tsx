import { useCallback, useEffect, useState, type RefObject } from "react";
import { ContextMenu, type ContextMenuItem } from "../../../components/ui/menu/ContextMenu";
import { contextMenuIcons } from "../../../components/ui/menu/contextMenuIcons";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { useI18n } from "../../../i18n";
import { formatShortcut, getShortcutKeys, matchesShortcut } from "../../../stores/shortcutsStore";
import { showToast } from "../../../stores/toastStore";
import { findStatementRangeAtOffset } from "../sqlIntel/sqlLex";
import { isSqlEditorFocused, resolveSqlToRun } from "../sqlIntel/sqlStatement";
import { formatSql, type SqlFormatStyle } from "../sqlEditor/language/formatter";
import { resolveSqlTableAtPos } from "../sqlEditor/language/sqlTableAtPos";
import { Catalog } from "../sqlEditor/catalog";
import { fetchTableDdl, type DbConnectionConfig } from "../api";
import { supportsTableDesign } from "../tableDesigner/resolveTableDesignerDriver";
import { rowsToRecord } from "../workspace/dbWorkspaceState";
import { toCsv } from "../shared/csvExport";
import { writeToClipboard } from "../panel/useDatabasePanelCsvExport";
import { sendToAiDock } from "../../../lib/ai/sendToAiDock";
import { useSettingsStore } from "../../../stores/settingsStore";
import type { DatabaseSchema } from "../types";
import type { QueryResult } from "../workspace/dbWorkspaceState";
import type { SqlEditorHandle, SqlEditorSelection } from "./SqlEditor";
import {
  compressSql,
  deleteEmptyLines,
  expandSelectStar,
  quoteSqlIdent,
  toDelimitedList,
  toggleBlockComment,
  toggleLineComment,
} from "./sqlEditorTextEdits";

type MenuPoint = { x: number; y: number };

function shortcutOf(id: string): string {
  const keys = getShortcutKeys(id);
  return keys[0] ? formatShortcut(keys[0]) : "";
}

function targetText(sel: SqlEditorSelection): { from: number; to: number; text: string } {
  if (sel.from !== sel.to) {
    return { from: sel.from, to: sel.to, text: sel.doc.slice(sel.from, sel.to) };
  }
  const range = findStatementRangeAtOffset(sel.doc, sel.head);
  return { from: range.from, to: range.to, text: sel.doc.slice(range.from, range.to) };
}

function tableInStatement(sql: string): { database: string; table: string } | null {
  const match = /\b(?:from|update|into|join|table)\s+([^\s(,;]+)/i.exec(sql);
  if (!match?.[1]) return null;
  const ident = match[1].replace(/[`"'[\]]/g, "");
  const parts = ident.split(".").filter(Boolean);
  const table = parts[parts.length - 1];
  if (!table) return null;
  return { database: parts.length > 1 ? parts[0]! : "", table };
}

async function copyTextImage(text: string, fontFamily: string, fontSize: number): Promise<boolean> {
  const lines = text.replace(/\s+$/, "").split("\n");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const pad = 16;
  const lineHeight = Math.round(fontSize * 1.45);
  ctx.font = `${fontSize}px ${fontFamily}`;
  const textWidth = Math.max(80, ...lines.map((line) => ctx.measureText(line || " ").width));
  const width = Math.ceil(textWidth + pad * 2);
  const height = Math.ceil(lines.length * lineHeight + pad * 2);
  const scale = 2;
  canvas.width = width * scale;
  canvas.height = height * scale;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(0, 0, width, height);
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.fillStyle = "#d4d4d4";
  lines.forEach((line, index) => {
    ctx.fillText(line, pad, pad + (index + 1) * lineHeight - 4);
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob || !navigator.clipboard?.write) return false;
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  return true;
}

export function SqlEditorContextMenu({
  editorRef,
  dbType,
  database,
  connection,
  schemas,
  result,
  menu,
  onClose,
  onRun,
  onRunFresh,
  onFind,
  onExportFile,
  onViewData,
  onDesignTable,
}: {
  editorRef: RefObject<SqlEditorHandle | null>;
  dbType?: string;
  database: string;
  connection: DbConnectionConfig | null;
  schemas: DatabaseSchema[];
  result: QueryResult | null;
  menu: MenuPoint | null;
  onClose: () => void;
  onRun: (sql: string) => void;
  onRunFresh: (sql: string) => void;
  onFind: () => void;
  onExportFile: () => void;
  onViewData: (target: { database: string; table: string }) => void;
  onDesignTable: (target: { database: string; table: string }) => void;
}) {
  const { t } = useI18n();
  const fontFamily = useSettingsStore((s) => s.sqlEditorFontFamily);
  const fontSize = useSettingsStore((s) => s.sqlEditorFontSize);
  const [ddlOpen, setDdlOpen] = useState(false);
  const [ddlText, setDdlText] = useState("");
  const [ddlLoading, setDdlLoading] = useState(false);

  const selection = useCallback(() => {
    return editorRef.current?.getSelection() ?? { doc: "", from: 0, to: 0, head: 0 };
  }, [editorRef]);

  const replaceTarget = useCallback(
    (transform: (text: string) => string, requireSelection = false) => {
      const editor = editorRef.current;
      if (!editor) return;
      const sel = editor.getSelection();
      if (requireSelection && sel.from === sel.to) {
        showToast(t("database.sqlEditorMenu.needSelection"));
        return;
      }
      const target = targetText(sel);
      if (!target.text.trim() && requireSelection) {
        showToast(t("database.sqlEditorMenu.needSelection"));
        return;
      }
      const next = transform(target.text);
      if (next === target.text) return;
      editor.replaceRange(target.from, target.to, next);
    },
    [editorRef, t],
  );

  const sqlToRun = useCallback(() => {
    const sel = selection();
    return resolveSqlToRun(sel.doc, sel);
  }, [selection]);

  const locateTable = useCallback(() => {
    const sel = selection();
    const atCursor = resolveSqlTableAtPos(sel.doc, sel.head, schemas, dbType);
    const catalog = Catalog.fromSchemas(schemas);
    if (atCursor) {
      const found = catalog.findTable(atCursor.tableName, atCursor.databaseName);
      return {
        database: atCursor.databaseName || database,
        table: atCursor.tableName,
        columns: found?.table.columns.map((column) => column.name) ?? [],
      };
    }
    const hinted = tableInStatement(targetText(sel).text);
    if (!hinted) return null;
    const found = catalog.findTable(hinted.table, hinted.database || database || undefined);
    return {
      database: found?.database.name || hinted.database || database,
      table: found?.table.name || hinted.table,
      columns: found?.table.columns.map((column) => column.name) ?? [],
    };
  }, [database, dbType, schemas, selection]);

  const runCurrent = useCallback(() => {
    const sql = sqlToRun();
    if (!sql.trim()) return;
    onRun(sql);
  }, [onRun, sqlToRun]);

  const runFresh = useCallback(() => {
    const sql = sqlToRun();
    if (!sql.trim()) return;
    onRunFresh(sql);
  }, [onRunFresh, sqlToRun]);

  const openTable = useCallback(
    (kind: "data" | "design" | "ddl") => {
      const located = locateTable();
      if (!located || !connection) {
        showToast(t("database.sqlEditorMenu.needTable"));
        return;
      }
      const payload = {
        connId: connection.id,
        dbName: located.database,
        tableName: located.table,
        connection,
      };
      if (kind === "data") {
        onViewData({ database: payload.dbName, table: payload.tableName });
        return;
      }
      if (kind === "design") {
        if (!supportsTableDesign(connection)) {
          showToast(t("database.sqlEditorMenu.needTable"));
          return;
        }
        onDesignTable({ database: payload.dbName, table: payload.tableName });
        return;
      }
      setDdlOpen(true);
      setDdlLoading(true);
      setDdlText("");
      void fetchTableDdl(connection, located.database, located.table)
        .then((ddl) => {
          setDdlText(ddl.trim());
          if (!ddl.trim()) showToast(t("database.sqlEditorMenu.ddlEmpty"));
        })
        .catch((err: unknown) => {
          setDdlText("");
          showToast(err instanceof Error ? err.message : t("database.sqlEditorMenu.ddlFailed"));
        })
        .finally(() => setDdlLoading(false));
    },
    [connection, locateTable, onDesignTable, onViewData, t],
  );

  const expandStar = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection();
    const target = targetText(sel);
    const located = locateTable();
    const next = expandSelectStar(
      target.text,
      located?.columns ?? [],
      (name) => quoteSqlIdent(dbType, name),
    );
    if (!next) {
      showToast(
        located && located.columns.length === 0
          ? t("database.sqlEditorMenu.needColumns")
          : t("database.sqlEditorMenu.needStar"),
      );
      return;
    }
    editor.replaceRange(target.from, target.to, next);
  }, [dbType, editorRef, locateTable, t]);

  const copySelection = useCallback(async () => {
    const text = targetText(selection()).text;
    if (!text) return;
    const ok = await writeToClipboard(text);
    if (ok) showToast(t("common.copied"));
  }, [selection, t]);

  const cutSelection = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection();
    if (sel.from === sel.to) {
      showToast(t("database.sqlEditorMenu.needSelection"));
      return;
    }
    const text = sel.doc.slice(sel.from, sel.to);
    const ok = await writeToClipboard(text);
    if (ok) editor.replaceRange(sel.from, sel.to, "");
  }, [editorRef, t]);

  const pasteText = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      showToast(t("database.sqlEditorMenu.needSelection"));
      return;
    }
    const sel = editor.getSelection();
    editor.replaceRange(sel.from, sel.to, text);
  }, [editorRef, t]);

  const screenshot = useCallback(async () => {
    const text = targetText(selection()).text.trim();
    if (!text) {
      showToast(t("database.sqlEditorMenu.needSelection"));
      return;
    }
    try {
      const ok = await copyTextImage(text, fontFamily || "monospace", fontSize || 13);
      showToast(ok ? t("database.sqlEditorMenu.screenshotDone") : t("database.sqlEditorMenu.screenshotFailed"));
    } catch {
      showToast(t("database.sqlEditorMenu.screenshotFailed"));
    }
  }, [fontFamily, fontSize, selection, t]);

  const sendAi = useCallback(() => {
    const text = targetText(selection()).text.trim();
    if (!text) return;
    void sendToAiDock(text, {
      contextChips: connection
        ? [{ type: "database", label: `${connection.name}${database ? ` · ${database}` : ""}` }]
        : undefined,
    });
  }, [connection, database, selection]);

  const formatTarget = useCallback((style: SqlFormatStyle = "pretty") => {
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection();
    if (sel.from !== sel.to) {
      editor.replaceRange(sel.from, sel.to, formatSql(sel.doc.slice(sel.from, sel.to), dbType, style));
      return;
    }
    editor.formatCurrentStatement(style);
  }, [dbType, editorRef]);

  const exportCsv = useCallback(async () => {
    if (!result || result.columns.length === 0) return;
    const ok = await writeToClipboard(toCsv(result.columns, rowsToRecord(result.columns, result.rows)));
    if (ok) showToast(t("common.copied"));
  }, [result, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !isSqlEditorFocused()) return;
      const run = (action: () => void) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      };
      if (matchesShortcut(event, getShortcutKeys("run-sql-new-result"))) {
        run(runFresh);
        return;
      }
      if (matchesShortcut(event, getShortcutKeys("sql-line-comment"))) {
        run(() => replaceTarget(toggleLineComment));
        return;
      }
      if (matchesShortcut(event, getShortcutKeys("sql-block-comment"))) {
        run(() => replaceTarget(toggleBlockComment));
        return;
      }
      if (matchesShortcut(event, getShortcutKeys("sql-expand-star"))) {
        run(expandStar);
        return;
      }
      if (matchesShortcut(event, getShortcutKeys("sql-send-to-ai"))) {
        run(sendAi);
        return;
      }
      if (matchesShortcut(event, getShortcutKeys("sql-upper"))) {
        run(() => replaceTarget((text) => text.toUpperCase()));
        return;
      }
      if (matchesShortcut(event, getShortcutKeys("sql-lower"))) {
        run(() => replaceTarget((text) => text.toLowerCase()));
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expandStar, replaceTarget, runFresh, sendAi]);

  const canExport = Boolean(result && result.columns.length > 0);
  const items: ContextMenuItem[] = [
    { id: "run", label: t("database.sqlEditorMenu.run"), shortcut: shortcutOf("run-current-sql"), icon: contextMenuIcons.play, onClick: runCurrent },
    { id: "run-new", label: t("database.sqlEditorMenu.runNewResult"), shortcut: shortcutOf("run-sql-new-result"), icon: contextMenuIcons.play, onClick: runFresh },
    {
      id: "export",
      label: t("database.sqlEditorMenu.export"),
      icon: contextMenuIcons.export,
      disabled: !canExport,
      children: [
        { id: "export-copy", label: t("database.sqlEditorMenu.exportClipboard"), icon: contextMenuIcons.copy, onClick: () => void exportCsv() },
        { id: "export-file", label: t("database.sqlEditorMenu.exportFile"), icon: contextMenuIcons.save, onClick: onExportFile },
      ],
    },
    { id: "sep-table", label: "", separator: true },
    { id: "view-data", label: t("database.sqlEditorMenu.viewData"), icon: contextMenuIcons.open, onClick: () => openTable("data") },
    { id: "design", label: t("database.sqlEditorMenu.designTable"), icon: contextMenuIcons.design, disabled: !connection || !supportsTableDesign(connection), onClick: () => openTable("design") },
    { id: "ddl", label: t("database.sqlEditorMenu.viewDdl"), icon: contextMenuIcons.file, onClick: () => openTable("ddl") },
    { id: "expand", label: t("database.sqlEditorMenu.expandStar"), shortcut: shortcutOf("sql-expand-star"), icon: contextMenuIcons.list, onClick: expandStar },
    { id: "sep-edit", label: "", separator: true },
    { id: "comment", label: t("database.sqlEditorMenu.lineComment"), shortcut: shortcutOf("sql-line-comment"), onClick: () => replaceTarget(toggleLineComment) },
    { id: "block-comment", label: t("database.sqlEditorMenu.blockComment"), shortcut: shortcutOf("sql-block-comment"), onClick: () => replaceTarget(toggleBlockComment) },
    { id: "format", label: t("database.sqlEditorMenu.formatSelection"), shortcut: shortcutOf("format-sql-statement"), onClick: () => formatTarget("pretty") },
    { id: "format-compact", label: t("database.sqlEditorMenu.formatCompact"), shortcut: shortcutOf("format-sql-compact"), onClick: () => formatTarget("compact") },
    { id: "compress", label: t("database.sqlEditorMenu.compress"), onClick: () => replaceTarget(compressSql) },
    { id: "sep-clip", label: "", separator: true },
    { id: "copy", label: t("database.sqlEditorMenu.copy"), shortcut: shortcutOf("copy") || formatShortcut(["Mod", "KeyC"]), icon: contextMenuIcons.copy, onClick: () => void copySelection() },
    { id: "shot", label: t("database.sqlEditorMenu.screenshot"), icon: contextMenuIcons.image, onClick: () => void screenshot() },
    { id: "cut", label: t("database.sqlEditorMenu.cut"), shortcut: formatShortcut(["Mod", "KeyX"]), icon: contextMenuIcons.cut, onClick: () => void cutSelection() },
    { id: "paste", label: t("database.sqlEditorMenu.paste"), shortcut: formatShortcut(["Mod", "KeyV"]), icon: contextMenuIcons.paste, onClick: () => void pasteText() },
    { id: "ai", label: t("database.sqlEditorMenu.sendToAi"), shortcut: shortcutOf("sql-send-to-ai"), icon: contextMenuIcons.ai, onClick: sendAi },
    { id: "sep-case", label: "", separator: true },
    { id: "upper", label: t("database.sqlEditorMenu.upper"), shortcut: shortcutOf("sql-upper"), onClick: () => replaceTarget((text) => text.toUpperCase()) },
    { id: "lower", label: t("database.sqlEditorMenu.lower"), shortcut: shortcutOf("sql-lower"), onClick: () => replaceTarget((text) => text.toLowerCase()) },
    { id: "list", label: t("database.sqlEditorMenu.delimitedList"), icon: contextMenuIcons.list, onClick: () => replaceTarget(toDelimitedList, true) },
    { id: "sep-find", label: "", separator: true },
    { id: "find", label: t("database.sqlEditorMenu.find"), shortcut: shortcutOf("search-terminal"), onClick: onFind },
    { id: "empty", label: t("database.sqlEditorMenu.deleteEmptyLines"), icon: contextMenuIcons.clear, onClick: () => replaceTarget(deleteEmptyLines) },
    { id: "all", label: t("database.sqlEditorMenu.selectAll"), shortcut: formatShortcut(["Mod", "KeyA"]), onClick: () => editorRef.current?.selectAll() },
  ];

  return (
    <>
      {menu ? (
        <ContextMenu items={items} position={menu} onClose={onClose} />
      ) : null}
      <FormDialog
        open={ddlOpen}
        onClose={() => setDdlOpen(false)}
        title={t("database.sqlEditorMenu.ddlTitle")}
        size="lg"
        cancelLabel={t("common.close")}
        primaryAction={{
          key: "copy-ddl",
          label: t("database.sqlEditorMenu.copyDdl"),
          disabled: ddlLoading || !ddlText,
          onClick: () => {
            void writeToClipboard(ddlText).then((ok) => {
              if (ok) showToast(t("common.copied"));
            });
          },
        }}
      >
        <pre className="sql-editor-ddl-preview">
          {ddlLoading ? t("database.sqlEditorMenu.ddlLoading") : ddlText || t("database.sqlEditorMenu.ddlEmpty")}
        </pre>
      </FormDialog>
    </>
  );
}
