import { useRef, useEffect, useCallback, useMemo } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import type { editor as MonacoEditor, IDisposable } from "monaco-editor";
import type { DatabaseSchema } from "./types";
import {
  bindEditorModelSchemas,
  ensureMonacoSqlCompletionProvider,
  unbindEditorModelSchemas,
} from "./lsp/monacoSqlCompletion";
import { isSqlMonacoEditorFocused, positionToOffset, sqlAtOffset } from "./lsp/sqlStatement";

/** 打开方式：独立查询页（sql）或侧栏点表后的表数据预览（data）。 */
export type SqlEditorOpenMode = "query" | "table";

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 与 DatabasePanel `tabModes` 对应：`sql` → query，`data` → table。 */
  openMode?: SqlEditorOpenMode;
  /** Cmd/Ctrl+Enter：执行光标所在的一条 SQL（由调用方传入已提取的语句）。 */
  onRun?: (sqlAtCursor: string) => void;
  /** 光标 offset 变化（供无焦点时 ⌘+Enter 使用）。 */
  onCursorOffsetChange?: (offset: number) => void;
  /** 当前上下文中的库表结构（通常仅含当前选中的数据库）。 */
  schemas?: DatabaseSchema[];
  readOnly?: boolean;
  /** 在只读模式下高亮匹配的搜索词（用于 ScopedSearch 宿主内的 Monaco）。 */
  highlightQuery?: string;
}

const THEME_DEFINITIONS: Record<string, MonacoEditor.IStandaloneThemeData> = {
  "omnipanel-dark": {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "007aff", fontStyle: "bold" },
      { token: "keyword.sql", foreground: "007aff", fontStyle: "bold" },
      { token: "predefined.sql", foreground: "ff9f0a" },
      { token: "string", foreground: "30d158" },
      { token: "string.sql", foreground: "30d158" },
      { token: "number", foreground: "ff9f0a" },
      { token: "comment", foreground: "6e6e73", fontStyle: "italic" },
      { token: "comment.sql", foreground: "6e6e73", fontStyle: "italic" },
      { token: "operator.sql", foreground: "fdfcfc" },
      { token: "predefined", foreground: "ff9f0a" },
      { token: "identifier", foreground: "fdfcfc" },
      { token: "type", foreground: "007aff" },
      { token: "variable", foreground: "c8c6c4" },
    ],
    colors: {
      "editor.background": "#1a1717",
      "editor.foreground": "#fdfcfc",
      "editor.lineHighlightBackground": "#302c2c40",
      "editor.selectionBackground": "#007aff30",
      "editor.inactiveSelectionBackground": "#007aff18",
      "editorCursor.foreground": "#fdfcfc",
      "editorLineNumber.foreground": "#6e6e73",
      "editorLineNumber.activeForeground": "#c8c6c4",
      "editorIndentGuide.background": "#302c2c",
      "editorIndentGuide.activeBackground": "#464343",
      "editorBracketMatch.background": "#007aff20",
      "editorBracketMatch.border": "#007aff50",
      "editorWidget.background": "#302c2c",
      "editorWidget.border": "#464343",
      "editorSuggestWidget.background": "#302c2c",
      "editorSuggestWidget.border": "#464343",
      "editorSuggestWidget.foreground": "#fdfcfc",
      "editorSuggestWidget.selectedBackground": "#007aff25",
      "editorSuggestWidget.highlightForeground": "#007aff",
      "editorHoverWidget.background": "#302c2c",
      "editorHoverWidget.border": "#464343",
      "list.activeSelectionBackground": "#007aff25",
      "list.activeSelectionForeground": "#fdfcfc",
      "list.highlightForeground": "#007aff",
      "scrollbarSlider.background": "#46434350",
      "scrollbarSlider.hoverBackground": "#46434380",
      "scrollbarSlider.activeBackground": "#464343a0",
      "minimap.background": "#1a1717",
    },
  },
  "omnipanel-light": {
    base: "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "007aff", fontStyle: "bold" },
      { token: "keyword.sql", foreground: "007aff", fontStyle: "bold" },
      { token: "predefined.sql", foreground: "ff9500" },
      { token: "string", foreground: "34c759" },
      { token: "string.sql", foreground: "34c759" },
      { token: "number", foreground: "ff9500" },
      { token: "comment", foreground: "aeaeb2", fontStyle: "italic" },
      { token: "comment.sql", foreground: "aeaeb2", fontStyle: "italic" },
      { token: "operator.sql", foreground: "1d1d1f" },
      { token: "predefined", foreground: "ff9500" },
      { token: "identifier", foreground: "1d1d1f" },
      { token: "type", foreground: "007aff" },
      { token: "variable", foreground: "424245" },
    ],
    colors: {
      "editor.background": "#e8e8ed",
      "editor.foreground": "#1d1d1f",
      "editor.lineHighlightBackground": "#ffffff60",
      "editor.selectionBackground": "#007aff20",
      "editor.inactiveSelectionBackground": "#007aff10",
      "editorCursor.foreground": "#1d1d1f",
      "editorLineNumber.foreground": "#aeaeb2",
      "editorLineNumber.activeForeground": "#424245",
      "editorIndentGuide.background": "#d2d2d7",
      "editorIndentGuide.activeBackground": "#aeaeb2",
      "editorBracketMatch.background": "#007aff15",
      "editorBracketMatch.border": "#007aff40",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#d2d2d7",
      "editorSuggestWidget.background": "#ffffff",
      "editorSuggestWidget.border": "#d2d2d7",
      "editorSuggestWidget.foreground": "#1d1d1f",
      "editorSuggestWidget.selectedBackground": "#007aff18",
      "editorSuggestWidget.highlightForeground": "#007aff",
      "editorHoverWidget.background": "#ffffff",
      "editorHoverWidget.border": "#d2d2d7",
      "list.activeSelectionBackground": "#007aff18",
      "list.activeSelectionForeground": "#1d1d1f",
      "list.highlightForeground": "#007aff",
      "scrollbarSlider.background": "#d2d2d760",
      "scrollbarSlider.hoverBackground": "#d2d2d790",
      "scrollbarSlider.activeBackground": "#d2d2d7b0",
      "minimap.background": "#e8e8ed",
    },
  },
};

function getActiveTheme(): string {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "omnipanel-light"
    : "omnipanel-dark";
}

function runStatementAtCursor(
  editor: MonacoEditor.IStandaloneCodeEditor,
  onRun: (sqlAtCursor: string) => void,
): void {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos) return;
  const text = model.getValue();
  const offset = positionToOffset(text, pos.lineNumber, pos.column);
  onRun(sqlAtOffset(text, offset));
}

export function SqlEditor({
  value,
  onChange,
  openMode = "query",
  onRun,
  onCursorOffsetChange,
  schemas = [],
  readOnly = false,
  highlightQuery = "",
}: SqlEditorProps) {
  const disposables = useRef<IDisposable[]>([]);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const highlightDecorationsRef = useRef<string[]>([]);
  const onRunRef = useRef(onRun);
  const onCursorOffsetChangeRef = useRef(onCursorOffsetChange);
  const readOnlyRef = useRef(readOnly);
  const schemasRef = useRef(schemas);
  onRunRef.current = onRun;
  onCursorOffsetChangeRef.current = onCursorOffsetChange;
  readOnlyRef.current = readOnly;
  schemasRef.current = schemas;

  const editorOptions = useMemo(
    (): MonacoEditor.IStandaloneEditorConstructionOptions => ({
      fontSize: 13,
      fontFamily: "var(--font-mono)",
      lineHeight: 22,
      tabSize: 2,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
      renderLineHighlight: "line",
      renderWhitespace: "selection",
      wordWrap: "on",
      automaticLayout: true,
      suggestOnTriggerCharacters: true,
      quickSuggestions: true,
      wordBasedSuggestions: "off",
      snippetSuggestions: "inline",
      tabCompletion: "on",
      suggest: {
        showKeywords: true,
        showFunctions: true,
        showSnippets: true,
        preview: true,
        insertMode: "replace",
      },
      folding: true,
      foldingStrategy: "indentation",
      bracketPairColorization: { enabled: true },
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      smoothScrolling: true,
      readOnly,
      contextmenu: true,
      mouseWheelZoom: true,
    }),
    [readOnly],
  );

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      for (const [name, data] of Object.entries(THEME_DEFINITIONS)) {
        monaco.editor.defineTheme(name, data);
      }
      monaco.editor.setTheme(getActiveTheme());

      monaco.languages.setLanguageConfiguration("sql", {
        comments: {
          lineComment: "--",
          blockComment: ["/*", "*/"],
        },
        brackets: [["(", ")"], ["[", "]"]],
        autoClosingPairs: [
          { open: "(", close: ")" },
          { open: "'", close: "'" },
          { open: '"', close: '"' },
          { open: "`", close: "`" },
          { open: "[", close: "]" },
        ],
        surroundingPairs: [
          { open: "(", close: ")" },
          { open: "'", close: "'" },
          { open: '"', close: '"' },
          { open: "`", close: "`" },
          { open: "[", close: "]" },
        ],
      });

      ensureMonacoSqlCompletionProvider(monaco);

      const bindCurrentModel = () => {
        const current = editor.getModel();
        if (current) {
          bindEditorModelSchemas(current, () => schemasRef.current);
        }
        return current;
      };

      bindCurrentModel();

      const modelDisposable = editor.onDidChangeModel((e) => {
        if (e.oldModelUrl) {
          const oldModel = monaco.editor.getModel(e.oldModelUrl);
          if (oldModel) {
            unbindEditorModelSchemas(oldModel);
          }
        }
        bindCurrentModel();
      });
      disposables.current.push(modelDisposable);

      disposables.current.push({
        dispose: () => {
          const current = editor.getModel();
          if (current) {
            unbindEditorModelSchemas(current);
          }
        },
      });

      const syncCursorOffset = () => {
        const model = editor.getModel();
        const pos = editor.getPosition();
        if (!model || !pos || !onCursorOffsetChangeRef.current) return;
        const offset = positionToOffset(
          model.getValue(),
          pos.lineNumber,
          pos.column,
        );
        onCursorOffsetChangeRef.current(offset);
      };

      const blurDisposable = editor.onDidBlurEditorWidget(() => {
        syncCursorOffset();
      });
      disposables.current.push(blurDisposable);

      if (openMode === "query") {
        editor.focus();
      }
    },
    [openMode],
  );

  // macOS Tauri WebView 下 Monaco addCommand 对 Cmd+Enter 不可靠；仅编辑器有焦点时在此处理。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter" || e.shiftKey || e.altKey) {
        return;
      }
      if (!isSqlMonacoEditorFocused()) return;
      const editor = editorRef.current;
      if (!editor?.hasTextFocus() || readOnlyRef.current) return;
      const run = onRunRef.current;
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      runStatementAtCursor(editor, run);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (editorRef.current) {
        void loader.init().then((m) => {
          m.editor.setTheme(getActiveTheme());
        });
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      for (const d of disposables.current) {
        try {
          d.dispose();
        } catch {
          // Monaco 共享实例下并发 dispose 可能抛出 Canceled，忽略即可
        }
      }
      disposables.current = [];
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const model = editor.getModel();
    if (!model) {
      return;
    }

    const needle = highlightQuery.trim();
    if (!needle) {
      highlightDecorationsRef.current = editor.deltaDecorations(
        highlightDecorationsRef.current,
        [],
      );
      return;
    }

    const matches = model.findMatches(needle, false, false, false, null, false);
    highlightDecorationsRef.current = editor.deltaDecorations(
      highlightDecorationsRef.current,
      matches.map((match) => ({
        range: match.range,
        options: {
          inlineClassName: "scoped-search-monaco-match",
          overviewRuler: {
            color: "var(--warn)",
            position: 1,
          },
        },
      })),
    );
  }, [value, highlightQuery]);

  return (
    <div className="sql-monaco-editor" data-open-mode={openMode}>
      <Editor
        defaultLanguage="sql"
        value={value}
        onChange={(val) => onChange(val ?? "")}
        onMount={handleMount}
        theme={getActiveTheme()}
        options={editorOptions}
      />
    </div>
  );
}
