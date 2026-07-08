import { useEffect, useRef } from "react";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { StreamLanguage } from "@codemirror/language";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { getSearchHighlightExtension, updateSearchHighlight } from "../../../modules/database/sql/sqlSearchHighlight";
import { getSqlEditorThemeExtensions, isLightTheme } from "../../../modules/database/sql/sqlEditorTheme";
import { useSettingsStore } from "../../../stores/settingsStore";

/** MySQL .cnf / .ini 语法高亮（legacy properties 模式，支持 [section]、# 注释与 key= value） */
const iniLanguage = StreamLanguage.define(properties);

export type CodeEditorLanguage = "text" | "sql" | "json" | "yaml" | "shell" | "dockerfile" | "ini";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: CodeEditorLanguage;
  readOnly?: boolean;
  /** 搜索高亮关键词（与 ScopedSearch 联动，由父组件传入） */
  highlightQuery?: string;
  height?: number | string;
  className?: string;
}

function languageExtension(language: CodeEditorLanguage): Extension {
  switch (language) {
    case "sql":
      return sql();
    case "json":
      return json();
    case "ini":
      return iniLanguage;
    default:
      return [];
  }
}

function languageFromFilePath(filePath: string | null | undefined): CodeEditorLanguage {
  if (!filePath) return "text";
  if (filePath.endsWith(".sql")) return "sql";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".cnf") || filePath.endsWith(".ini") || filePath.endsWith(".conf")) {
    return "ini";
  }
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) return "yaml";
  if (filePath.endsWith(".sh")) return "shell";
  return "dockerfile";
}

export function codeEditorLanguageFromPath(filePath: string): CodeEditorLanguage {
  return languageFromFilePath(filePath);
}

/** 轻量 CodeMirror 编辑器，复用 SQL 编辑器的主题与字体设置 */
export function CodeEditor({
  value,
  onChange,
  language = "text",
  readOnly = false,
  highlightQuery = "",
  height = "100%",
  className,
}: CodeEditorProps) {
  const sqlEditorFontFamily = useSettingsStore((s) => s.sqlEditorFontFamily);
  const sqlEditorFontSize = useSettingsStore((s) => s.sqlEditorFontSize);
  const sqlEditorLineHeight = useSettingsStore((s) => s.sqlEditorLineHeight);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const languageRef = useRef(language);
  const themeCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());

  onChangeRef.current = onChange;
  valueRef.current = value;
  languageRef.current = language;

  useEffect(() => {
    if (!containerRef.current) return;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      EditorState.tabSize.of(2),
      languageCompartment.current.of(languageExtension(languageRef.current)),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      themeCompartment.current.of(
        getSqlEditorThemeExtensions(isLightTheme(), {
          fontFamily: sqlEditorFontFamily,
          fontSize: sqlEditorFontSize,
          lineHeight: sqlEditorLineHeight,
        }),
      ),
      readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const next = update.state.doc.toString();
          if (next !== valueRef.current) {
            valueRef.current = next;
            onChangeRef.current(next);
          }
        }
      }),
      getSearchHighlightExtension(),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.current.reconfigure(languageExtension(language)),
    });
  }, [language]);

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

  return (
    <div
      className={className ? `code-editor ${className}` : "code-editor"}
      style={{ height, minHeight: 0, overflow: "hidden" }}
    >
      <div ref={containerRef} className="code-editor__host" style={{ height: "100%" }} />
    </div>
  );
}

