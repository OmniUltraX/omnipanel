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
import { getSqlEditorThemeExtensions, isLightTheme } from "../../../modules/database/sql/sqlEditorTheme";
import { useSettingsStore } from "../../../stores/settingsStore";

export type CodeEditorLanguage = "text" | "sql" | "json" | "yaml" | "shell" | "dockerfile";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: CodeEditorLanguage;
  readOnly?: boolean;
  height?: number | string;
  className?: string;
}

function languageExtension(language: CodeEditorLanguage): Extension {
  switch (language) {
    case "sql":
      return sql();
    case "json":
      return json();
    default:
      return [];
  }
}

function languageFromFilePath(filePath: string | null | undefined): CodeEditorLanguage {
  if (!filePath) return "text";
  if (filePath.endsWith(".sql")) return "sql";
  if (filePath.endsWith(".json")) return "json";
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) return "yaml";
  if (filePath.endsWith(".sh")) return "shell";
  return "dockerfile";
}

export function codeEditorLanguageFromPath(filePath: string): CodeEditorLanguage {
  return languageFromFilePath(filePath);
}

/** 轻量 CodeMirror 编辑器，用于�?SQL 场景的简单文本编辑�?*/
export function CodeEditor({
  value,
  onChange,
  language = "text",
  readOnly = false,
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
  const themeCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());

  onChangeRef.current = onChange;
  valueRef.current = value;

  useEffect(() => {
    if (!containerRef.current) return;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      EditorState.tabSize.of(2),
      languageExtension(language),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap]),
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
      }),
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
