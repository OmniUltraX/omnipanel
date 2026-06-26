import {
  forwardRef,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
} from "react";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import { sql } from "@codemirror/lang-sql";
import { autocompletion, completionKeymap, closeBrackets } from "@codemirror/autocomplete";
import type { DatabaseSchema } from "./types";
import { createSqlCompletionSource, sqlCompletionReopenOnDelete } from "./lsp/codemirrorSqlCompletion";
import {
  positionToOffset,
  sqlAtOffset,
  isSqlEditorFocused,
  findStatementRangeAtOffset,
} from "./lsp/sqlStatement";
import { getSqlEditorThemeExtensions, isLightTheme } from "./sqlEditorTheme";
import { getSearchHighlightExtension, updateSearchHighlight } from "./sqlSearchHighlight";
import { formatSql, formatSqlRange } from "./sqlIntel/sqlFormat";
import { resolveSqlDialect } from "./sqlIntel/sqlDialect";
import { createSqlIntelExtensions } from "./sqlIntel/cm/extensions";
import { getShortcutKeys, matchesShortcut } from "../../stores/shortcutsStore";
import { useSettingsStore } from "../../stores/settingsStore";

/** 打开方式：独立查询页（sql）或侧栏点表后的表数据预览（data）。 */
export type SqlEditorOpenMode = "query" | "table";

export interface SqlEditorHandle {
  formatAll: () => void;
  formatCurrentStatement: () => void;
}

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 与 DatabasePanel `tabModes` 对应：`sql` → query，`data` → table。 */
  openMode?: SqlEditorOpenMode;
  /** 连接 db_type，驱动语法高亮与格式化方言。 */
  dbType?: string;
  /** Cmd/Ctrl+Enter：执行光标所在的一条 SQL（由调用方传入已提取的语句）。 */
  onRun?: (sqlAtCursor: string) => void;
  /** Cmd/Ctrl+S：保存查询文件（阻止浏览器默认保存页行为）。 */
  onSave?: () => void;
  /** 光标 offset 变化（供无焦点时 ⌘+Enter 使用）。 */
  onCursorOffsetChange?: (offset: number) => void;
  /** 当前上下文中的库表结构（通常仅含当前选中的数据库）。 */
  schemas?: DatabaseSchema[];
  readOnly?: boolean;
  /** 在只读模式下高亮匹配的搜索词（用于 ScopedSearch 宿主内的编辑器）。 */
  highlightQuery?: string;
  /** false 时仅 CSS 隐藏，保留编辑器实例（切换 Tab 更快）。 */
  editorActive?: boolean;
}

function runStatementAtCursor(
  view: EditorView,
  onRun: (sqlAtCursor: string) => void,
): void {
  const text = view.state.doc.toString();
  const offset = view.state.selection.main.head;
  onRun(sqlAtOffset(text, offset));
}

function applyFormatToView(
  view: EditorView,
  dbType: string | undefined,
  range?: { from: number; to: number },
): void {
  const current = view.state.doc.toString();
  const head = view.state.selection.main.head;

  if (range) {
    const { text, cursor } = formatSqlRange(current, range.from, range.to, head, dbType);
    if (text === current) {
      return;
    }
    view.dispatch({
      changes: { from: 0, to: current.length, insert: text },
      selection: { anchor: cursor },
    });
    return;
  }

  const formatted = formatSql(current, dbType);
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
    onSave,
    onCursorOffsetChange,
    schemas = [],
    readOnly = false,
    highlightQuery = "",
    editorActive = true,
  },
  ref,
) {
  const sqlEditorFontFamily = useSettingsStore((s) => s.sqlEditorFontFamily);
  const sqlEditorFontSize = useSettingsStore((s) => s.sqlEditorFontSize);
  const sqlEditorLineHeight = useSettingsStore((s) => s.sqlEditorLineHeight);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const onSaveRef = useRef(onSave);
  const onCursorOffsetChangeRef = useRef(onCursorOffsetChange);
  const readOnlyRef = useRef(readOnly);
  const schemasRef = useRef(schemas);
  const dbTypeRef = useRef(dbType);
  const valueRef = useRef(value);
  const themeCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());

  onChangeRef.current = onChange;
  onRunRef.current = onRun;
  onSaveRef.current = onSave;
  onCursorOffsetChangeRef.current = onCursorOffsetChange;
  readOnlyRef.current = readOnly;
  schemasRef.current = schemas;
  dbTypeRef.current = dbType;
  valueRef.current = value;

  const syncCursorOffset = useCallback((view: EditorView) => {
    if (!onCursorOffsetChangeRef.current) return;
    const text = view.state.doc.toString();
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const column = head - line.from + 1;
    onCursorOffsetChangeRef.current(positionToOffset(text, line.number, column));
  }, []);

  const formatAllInView = useCallback(() => {
    const view = viewRef.current;
    if (!view || readOnlyRef.current) return;
    applyFormatToView(view, dbTypeRef.current);
  }, []);

  const formatCurrentStatementInView = useCallback(() => {
    const view = viewRef.current;
    if (!view || readOnlyRef.current) return;
    const text = view.state.doc.toString();
    const head = view.state.selection.main.head;
    applyFormatToView(view, dbTypeRef.current, findStatementRangeAtOffset(text, head));
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      formatAll: formatAllInView,
      formatCurrentStatement: formatCurrentStatementInView,
    }),
    [formatAllInView, formatCurrentStatementInView],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const dialectProfile = resolveSqlDialect(dbTypeRef.current);

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      dropCursor(),
      history(),
      EditorState.tabSize.of(2),
      indentOnInput(),
      bracketMatching(),
      foldGutter(),
      closeBrackets(),
      languageCompartment.current.of(
        sql({ dialect: dialectProfile.cmDialect, upperCaseKeywords: true }),
      ),
      EditorView.lineWrapping,
      getSearchHighlightExtension(),
      ...createSqlIntelExtensions({
        highlightActiveStatement: true,
        getDbType: () => dbTypeRef.current,
      }),
      autocompletion({
        activateOnTyping: true,
        maxRenderedOptions: 80,
        icons: true,
        optionClass: (completion) =>
          `cm-sql-completion cm-sql-completion--${completion.type ?? "text"}`,
        override: [
          createSqlCompletionSource(() => schemasRef.current, () => dbTypeRef.current),
        ],
      }),
      sqlCompletionReopenOnDelete(),
      keymap.of([
        {
          key: "Mod-Enter",
          run: (view) => {
            if (readOnlyRef.current) return false;
            const run = onRunRef.current;
            if (!run) return false;
            runStatementAtCursor(view, run);
            return true;
          },
        },
        {
          key: "Mod-s",
          run: () => {
            if (readOnlyRef.current) return false;
            const save = onSaveRef.current;
            if (!save) return false;
            save();
            return true;
          },
        },
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      themeCompartment.current.of(getSqlEditorThemeExtensions(isLightTheme())),
      readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const next = update.state.doc.toString();
          if (next !== valueRef.current) {
            valueRef.current = next;
            onChangeRef.current(next);
          }
        }
        if (update.selectionSet) {
          syncCursorOffset(update.view);
        }
        if (update.focusChanged && !update.view.hasFocus) {
          syncCursorOffset(update.view);
        }
      }),
      EditorView.domEventHandlers({
        blur: (_event, view) => {
          syncCursorOffset(view);
          return false;
        },
      }),
    ];

    const state = EditorState.create({
      doc: value,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    if (openMode === "query") {
      requestAnimationFrame(() => view.focus());
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
  }, []);

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
    updateSearchHighlight(view, highlightQuery);
  }, [value, highlightQuery]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const profile = resolveSqlDialect(dbType);
    view.dispatch({
      effects: languageCompartment.current.reconfigure(
        sql({ dialect: profile.cmDialect, upperCaseKeywords: true }),
      ),
    });
  }, [dbType]);

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
  }, [sqlEditorFontFamily, sqlEditorFontSize, sqlEditorLineHeight]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter" || e.shiftKey || e.altKey) {
        return;
      }
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s" || e.shiftKey || e.altKey) {
        return;
      }
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
      if (!matchesShortcut(e, getShortcutKeys("format-sql-statement"))) {
        return;
      }
      if (!isSqlEditorFocused()) return;
      const view = viewRef.current;
      if (!view?.hasFocus || readOnlyRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      formatCurrentStatementInView();
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
      className={`sql-codemirror-editor${editorActive ? "" : " sql-codemirror-editor--inactive"}`}
      data-open-mode={openMode}
      aria-hidden={editorActive ? undefined : true}
    >
      <div ref={containerRef} className="sql-codemirror-editor__host" />
    </div>
  );
});
