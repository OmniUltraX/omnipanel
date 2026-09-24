import {
  forwardRef,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { sql } from "@codemirror/lang-sql";
import type { DatabaseSchema } from "../../types";
import {
  positionToOffset,
  sqlAtOffset,
  resolveSqlToRun,
  isSqlEditorFocused,
  findStatementRangeAtOffset,
} from "../language/selection";
import { getSqlEditorThemeExtensions, isLightTheme } from "../../sql/sqlEditorTheme";
import { openSqlEditorMenu } from "../../sql/sqlEditorMenuSignal";
import { attachSqlEditorWheelZoom } from "../../sql/sqlEditorZoom";
import {
  clearSearchHighlight,
  findNextSearchMatch,
  findPrevSearchMatch,
  getSearchMatchInfo,
  replaceAllSearchMatches,
  replaceCurrentSearchMatch,
  updateSearchHighlight,
  type SqlSearchMatchInfo,
} from "../../sql/sqlSearchHighlight";
import { formatSql, formatSqlRange, type SqlFormatStyle } from "../language/formatter";
import { resolveSqlDialect } from "../../sqlIntel/sqlDialect";
import { restoreDockWindowChromeAfterLayout } from "../../../../lib/restoreDockWindowChromeAfterLayout";
import { findSqlInDoc, setSqlFrameErrorEffect, setSqlFrameFocusEffect } from "../language/sqlStatementFrame";
import { createSqlEditorExtensions } from "./extensions";
import { getShortcutKeys, matchesShortcut } from "../../../../stores/shortcutsStore";
import { useSettingsStore } from "../../../../stores/settingsStore";
import type { SqlGotoTableTarget } from "../language/sqlGotoTable";
/** 打开方式：独立查询页（sql）或侧栏点表后的表数据预览（data）。 */
export type SqlEditorOpenMode = "query" | "table";

export type { SqlSearchMatchInfo };

export interface SqlEditorSearchApi {
  setQuery: (query: string, options?: { scroll?: boolean }) => SqlSearchMatchInfo;
  findNext: () => SqlSearchMatchInfo;
  findPrev: () => SqlSearchMatchInfo;
  replaceCurrent: (replacement: string) => SqlSearchMatchInfo;
  replaceAll: (replacement: string) => number;
  getMatchInfo: () => SqlSearchMatchInfo;
  clear: () => void;
}

export interface SqlEditorSelection {
  doc: string;
  from: number;
  to: number;
  head: number;
}

export interface SqlEditorHandle {
  formatAll: () => void;
  formatCurrentStatement: (style?: SqlFormatStyle) => void;
  getSqlAtCursor: () => string;
  getSelectedSql: () => string;
  getSelection: () => SqlEditorSelection;
  replaceRange: (from: number, to: number, insert: string) => void;
  selectAll: () => void;
  /** 框住文档里对应的 SQL，并滚到可见区域。找不到则不动。 */
  highlightSql: (sql: string) => boolean;
  search: SqlEditorSearchApi;
}

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 与 DatabasePanel `tabModes` 对应：`sql` → query，`data` → table。 */
  openMode?: SqlEditorOpenMode;
  /** 连接 db_type，驱动语法高亮与格式化方言。 */
  dbType?: string;
  /** 执行光标所在的一条 SQL（由调用方传入已提取的语句）。快捷键 run-current-sql。 */
  onRun?: (sqlAtCursor: string) => void;
  /** 执行选中的 SQL（无选中时由调用方决定行为，通常回退到 onRun）。快捷键 run-selected-sql。 */
  onRunSelected?: (selectedSql: string) => void;
  /** 执行全部 SQL。快捷键 run-all-sql。 */
  onRunAll?: () => void;
  /** 保存查询文件（阻止浏览器默认保存页行为）。快捷键 save-sql-file。 */
  onSave?: () => void;
  /** Ctrl/Cmd+点击表名时打开对应表数据面板。 */
  onOpenTable?: (target: SqlGotoTableTarget) => void;
  /** 光标 offset 变化（供无焦点时 ⌘+Enter 使用）。 */
  onCursorOffsetChange?: (offset: number) => void;
  /** 是否存在非空选区，供工具栏切换「执行全部 / 执行选中」。 */
  onHasSelectionChange?: (hasSelection: boolean) => void;
  /** 最近一次执行失败的语句和数据库原文，用于红框、下划线和修复。 */
  execError?: { sql: string; message: string } | null;
  onExplainError?: () => void;
  /** 当前上下文中的库表结构（通常仅含当前选中的数据库）。 */
  schemas?: DatabaseSchema[];
  readOnly?: boolean;
  /** 在只读模式下高亮匹配的搜索词（用于 ScopedSearch 宿主内的编辑器）。 */
  highlightQuery?: string;
  /** false 时仅 CSS 隐藏，保留编辑器实例（切换 Tab 更快）。 */
  editorActive?: boolean;
  /** 右键：先把光标落到点击处（不打断已有选区），再交给外层菜单。 */
  onContextMenu?: (position: { x: number; y: number }) => void;
  /** 右键菜单归属。有值时直接打开编辑器菜单，不依赖 React 的 onContextMenu。 */
  contextMenuKey?: string;
}

function runStatementAtCursor(
  view: EditorView,
  onRun: (sqlAtCursor: string) => void,
): void {
  const text = view.state.doc.toString();
  const { from, to, head } = view.state.selection.main;
  const sql = resolveSqlToRun(text, { from, to, head });
  const range = from !== to ? { from, to } : findSqlInDoc(text, sql);
  if (range) {
    view.dispatch({ effects: setSqlFrameFocusEffect.of(range) });
  }
  onRun(sql);
}

function applyFormatToView(
  view: EditorView,
  dbType: string | undefined,
  range?: { from: number; to: number },
  style: SqlFormatStyle = "pretty",
): void {
  const current = view.state.doc.toString();
  const head = view.state.selection.main.head;

  if (range) {
    const { text, cursor } = formatSqlRange(current, range.from, range.to, head, dbType, style);
    if (text === current) {
      return;
    }
    view.dispatch({
      changes: { from: 0, to: current.length, insert: text },
      selection: { anchor: cursor },
    });
    return;
  }

  const formatted = formatSql(current, dbType, style);
  if (formatted === current) {
    return;
  }
  view.dispatch({
    changes: { from: 0, to: current.length, insert: formatted },
    selection: { anchor: Math.min(head, formatted.length) },
  });
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  {
    value,
    onChange,
    openMode = "query",
    dbType,
    onRun,
    onRunSelected,
    onRunAll,
    onSave,
    onOpenTable,
    onCursorOffsetChange,
    onHasSelectionChange,
    execError,
    onExplainError,
    schemas = [],
    readOnly = false,
    highlightQuery = "",
    editorActive = true,
    onContextMenu,
    contextMenuKey,
  },
  ref,
) {
  const sqlEditorFontFamily = useSettingsStore((s) => s.sqlEditorFontFamily);
  const sqlEditorFontSize = useSettingsStore((s) => s.sqlEditorFontSize);
  const sqlEditorLineHeight = useSettingsStore((s) => s.sqlEditorLineHeight);
  const sqlKeywordCase = useSettingsStore((s) => s.sqlKeywordCase);

  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const onRunSelectedRef = useRef(onRunSelected);
  const onRunAllRef = useRef(onRunAll);
  const onSaveRef = useRef(onSave);
  const onOpenTableRef = useRef(onOpenTable);
  const onCursorOffsetChangeRef = useRef(onCursorOffsetChange);
  const onHasSelectionChangeRef = useRef(onHasSelectionChange);
  const onExplainErrorRef = useRef(onExplainError);
  const onContextMenuRef = useRef(onContextMenu);
  const contextMenuKeyRef = useRef(contextMenuKey);
  const readOnlyRef = useRef(readOnly);
  const schemasRef = useRef(schemas);
  const dbTypeRef = useRef(dbType);
  const sqlKeywordCaseRef = useRef(sqlKeywordCase);
  const valueRef = useRef(value);
  const themeCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());

  onChangeRef.current = onChange;
  onRunRef.current = onRun;
  onRunSelectedRef.current = onRunSelected;
  onRunAllRef.current = onRunAll;
  onSaveRef.current = onSave;
  onOpenTableRef.current = onOpenTable;
  onCursorOffsetChangeRef.current = onCursorOffsetChange;
  onHasSelectionChangeRef.current = onHasSelectionChange;
  onExplainErrorRef.current = onExplainError;
  onContextMenuRef.current = onContextMenu;
  contextMenuKeyRef.current = contextMenuKey;
  readOnlyRef.current = readOnly;
  schemasRef.current = schemas;
  dbTypeRef.current = dbType;
  sqlKeywordCaseRef.current = sqlKeywordCase;
  valueRef.current = value;

  const syncCursorOffset = useCallback((view: EditorView) => {
    if (!onCursorOffsetChangeRef.current) return;
    const text = view.state.doc.toString();
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const column = head - line.from + 1;
    onCursorOffsetChangeRef.current(positionToOffset(text, line.number, column));
    const range = view.state.selection.main;
    const selected = view.state.doc.sliceString(range.from, range.to).trim().length > 0;
    onHasSelectionChangeRef.current?.(selected);
  }, []);

  const formatAllInView = useCallback(() => {
    const view = viewRef.current;
    if (!view || readOnlyRef.current) return;
    applyFormatToView(view, dbTypeRef.current);
  }, []);

  const formatCurrentStatementInView = useCallback((style: SqlFormatStyle = "pretty") => {
    const view = viewRef.current;
    if (!view || readOnlyRef.current) return;
    const text = view.state.doc.toString();
    const head = view.state.selection.main.head;
    applyFormatToView(view, dbTypeRef.current, findStatementRangeAtOffset(text, head), style);
  }, []);

  const getSqlAtCursorFromView = useCallback((): string => {
    const view = viewRef.current;
    const text = view?.state.doc.toString() ?? valueRef.current;
    const head = view?.state.selection.main.head ?? text.length;
    return sqlAtOffset(text, head);
  }, []);

  const getSelectedSqlFromView = useCallback((): string => {
    const view = viewRef.current;
    if (!view) return "";
    const { from, to } = view.state.selection.main;
    if (from === to) return "";
    return view.state.doc.sliceString(from, to).trim();
  }, []);

  const getSelectionFromView = useCallback((): SqlEditorSelection => {
    const view = viewRef.current;
    const doc = view?.state.doc.toString() ?? valueRef.current;
    if (!view) return { doc, from: 0, to: 0, head: 0 };
    const { from, to, head } = view.state.selection.main;
    return { doc, from, to, head };
  }, []);

  const replaceRangeInView = useCallback((from: number, to: number, insert: string) => {
    const view = viewRef.current;
    if (!view || readOnlyRef.current) return;
    const nextHead = from + insert.length;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: nextHead },
    });
    view.focus();
  }, []);

  const selectAllInView = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
  }, []);

  const openContextMenuAt = useCallback((event: { clientX: number; clientY: number; preventDefault: () => void }) => {
    event.preventDefault();
    const view = viewRef.current;
    if (view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null) {
        const sel = view.state.selection.main;
        const inside = pos >= sel.from && pos <= sel.to && sel.from !== sel.to;
        if (!inside) {
          view.dispatch({ selection: { anchor: pos } });
        }
      }
    }
    const menuKey = contextMenuKeyRef.current;
    if (menuKey) {
      openSqlEditorMenu({ key: menuKey, x: event.clientX, y: event.clientY });
    }
    onContextMenuRef.current?.({ x: event.clientX, y: event.clientY });
  }, []);

  const openContextMenuAtRef = useRef(openContextMenuAt);
  openContextMenuAtRef.current = openContextMenuAt;

  const handleNativeContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      openContextMenuAtRef.current(event);
    },
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onNativeContextMenu = (event: MouseEvent) => {
      openContextMenuAtRef.current(event);
    };
    root.addEventListener("contextmenu", onNativeContextMenu);
    return () => root.removeEventListener("contextmenu", onNativeContextMenu);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      formatAll: formatAllInView,
      formatCurrentStatement: formatCurrentStatementInView,
      getSqlAtCursor: getSqlAtCursorFromView,
      getSelectedSql: getSelectedSqlFromView,
      getSelection: getSelectionFromView,
      replaceRange: replaceRangeInView,
      selectAll: selectAllInView,
      highlightSql: (sql: string) => {
        const view = viewRef.current;
        if (!view) return false;
        const range = findSqlInDoc(view.state.doc.toString(), sql);
        if (!range) return false;
        view.dispatch({
          effects: [
            setSqlFrameFocusEffect.of(range),
            EditorView.scrollIntoView(range.from, { y: "center" }),
          ],
        });
        return true;
      },
      search: {
        setQuery: (query, options) => {
          const view = viewRef.current;
          if (!view) return { current: 0, total: 0 };
          return updateSearchHighlight(view, query, { scroll: options?.scroll });
        },
        findNext: () => {
          const view = viewRef.current;
          if (!view) return { current: 0, total: 0 };
          return findNextSearchMatch(view);
        },
        findPrev: () => {
          const view = viewRef.current;
          if (!view) return { current: 0, total: 0 };
          return findPrevSearchMatch(view);
        },
        replaceCurrent: (replacement) => {
          const view = viewRef.current;
          if (!view) return { current: 0, total: 0 };
          return replaceCurrentSearchMatch(view, replacement);
        },
        replaceAll: (replacement) => {
          const view = viewRef.current;
          if (!view) return 0;
          return replaceAllSearchMatches(view, replacement);
        },
        getMatchInfo: () => {
          const view = viewRef.current;
          if (!view) return { current: 0, total: 0 };
          return getSearchMatchInfo(view);
        },
        clear: () => {
          const view = viewRef.current;
          if (!view) return;
          clearSearchHighlight(view);
        },
      },
    }),
    [
      formatAllInView,
      formatCurrentStatementInView,
      getSelectionFromView,
      getSelectedSqlFromView,
      getSqlAtCursorFromView,
      replaceRangeInView,
      selectAllInView,
    ],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = createSqlEditorExtensions({
      getSchemas: () => schemasRef.current,
      getDbType: () => dbTypeRef.current,
      getKeywordCase: () => sqlKeywordCaseRef.current,
      getReadOnly: () => readOnlyRef.current,
      onDocChange: (next) => {
        if (next !== valueRef.current) {
          valueRef.current = next;
          onChangeRef.current(next);
        }
      },
      onCursorSync: syncCursorOffset,
      getOnRun: () => onRunRef.current,
      getOnSave: () => onSaveRef.current,
      getOnOpenTable: () => onOpenTableRef.current,
      onExplainError: () => onExplainErrorRef.current?.(),
      themeCompartment: themeCompartment.current,
      readOnlyCompartment: readOnlyCompartment.current,
      languageCompartment: languageCompartment.current,
    });

    const state = EditorState.create({
      doc: value,
      extensions,
    });
    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    const detachZoom = attachSqlEditorWheelZoom(containerRef.current);

    if (openMode === "query") {
      requestAnimationFrame(() => view.focus());
    }

    return () => {
      detachZoom();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: setSqlFrameErrorEffect.of(execError ?? null),
    });
  }, [execError]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      valueRef.current = value;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    updateSearchHighlight(view, highlightQuery, { scroll: Boolean(highlightQuery.trim()) });
  }, [value, highlightQuery]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const profile = resolveSqlDialect(dbType);
    view.dispatch({
      effects: languageCompartment.current.reconfigure(
        sql({ dialect: profile.cmDialect, upperCaseKeywords: sqlKeywordCase === "upper" }),
      ),
    });
  }, [dbType, sqlKeywordCase]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        getSqlEditorThemeExtensions(isLightTheme()),
      ),
    });
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeCompartment.current.reconfigure(
          getSqlEditorThemeExtensions(isLightTheme(), {
            fontFamily: sqlEditorFontFamily,
            fontSize: sqlEditorFontSize,
            lineHeight: sqlEditorLineHeight,
          }),
        ),
      });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [sqlEditorFontFamily, sqlEditorFontSize, sqlEditorLineHeight]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        getSqlEditorThemeExtensions(isLightTheme(), {
          fontFamily: sqlEditorFontFamily,
          fontSize: sqlEditorFontSize,
          lineHeight: sqlEditorLineHeight,
        }),
      ),
    });
    restoreDockWindowChromeAfterLayout("database");
  }, [sqlEditorFontFamily, sqlEditorFontSize, sqlEditorLineHeight]);

  // run-current-sql：Ctrl+Enter / Ctrl+Shift+R（执行光标所在语句）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!matchesShortcut(e, getShortcutKeys("run-current-sql"))) return;
      if (!isSqlEditorFocused()) return;
      const view = viewRef.current;
      if (!view?.hasFocus || readOnlyRef.current) return;
      const run = onRunRef.current;
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      runStatementAtCursor(view, run);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // run-selected-sql：Ctrl+Shift+Enter / Ctrl+Shift+R（执行选中；无选中时回退到光标所在语句）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!matchesShortcut(e, getShortcutKeys("run-selected-sql"))) return;
      if (!isSqlEditorFocused()) return;
      const view = viewRef.current;
      if (!view?.hasFocus || readOnlyRef.current) return;
      const { from, to, head } = view.state.selection.main;
      const hasSelection = from !== to;
      e.preventDefault();
      e.stopPropagation();
      if (hasSelection) {
        const runSelected = onRunSelectedRef.current;
        if (!runSelected) return;
        const selected = view.state.sliceDoc(from, to);
        view.dispatch({ effects: setSqlFrameFocusEffect.of({ from, to }) });
        runSelected(selected);
      } else {
        // 无选中：回退到运行光标所在语句
        const run = onRunRef.current;
        if (!run) return;
        const text = view.state.doc.toString();
        run(resolveSqlToRun(text, { from, to, head }));
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // run-all-sql：Ctrl+Shift+Alt+Enter（执行全部）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!matchesShortcut(e, getShortcutKeys("run-all-sql"))) return;
      if (!isSqlEditorFocused()) return;
      const view = viewRef.current;
      if (!view?.hasFocus || readOnlyRef.current) return;
      const runAll = onRunAllRef.current;
      if (!runAll) return;
      e.preventDefault();
      e.stopPropagation();
      runAll();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // save-sql-file：Ctrl+S（保存查询文件）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!matchesShortcut(e, getShortcutKeys("save-sql-file"))) return;
      if (!isSqlEditorFocused()) return;
      const view = viewRef.current;
      if (!view?.hasFocus || readOnlyRef.current) return;
      const save = onSaveRef.current;
      if (!save) return;
      e.preventDefault();
      e.stopPropagation();
      save();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const compact = matchesShortcut(e, getShortcutKeys("format-sql-compact"));
      if (!compact && !matchesShortcut(e, getShortcutKeys("format-sql-statement"))) {
        return;
      }
      if (!isSqlEditorFocused()) return;
      const view = viewRef.current;
      if (!view?.hasFocus || readOnlyRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      formatCurrentStatementInView(compact ? "compact" : "pretty");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [formatCurrentStatementInView]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!matchesShortcut(e, getShortcutKeys("format-sql"))) {
        return;
      }
      if (!isSqlEditorFocused()) return;
      const view = viewRef.current;
      if (!view?.hasFocus || readOnlyRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      formatAllInView();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [formatAllInView]);

  useEffect(() => {
    if (!editorActive) return;
    const view = viewRef.current;
    if (!view) return;
    requestAnimationFrame(() => {
      view.requestMeasure();
    });
  }, [editorActive]);

  return (
    <div
      ref={rootRef}
      className={`sql-codemirror-editor${editorActive ? "" : " sql-codemirror-editor--inactive"}`}
      data-open-mode={openMode}
      aria-hidden={editorActive ? undefined : true}
      onContextMenu={handleNativeContextMenu}
    >
      <div ref={containerRef} className="sql-codemirror-editor__host" />
    </div>
  );
});
