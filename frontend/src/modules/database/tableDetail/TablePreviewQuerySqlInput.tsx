import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
  drawSelection,
  tooltips,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionKeymap,
  completionStatus,
} from "@codemirror/autocomplete";
import type { DbColumnMeta } from "../api";
import { resolveSqlDialect } from "../sqlIntel/sqlDialect";
import {
  getSqlEditorTypographyFromStore,
  getSqlInlineInputThemeExtensions,
  isLightTheme,
} from "../sql/sqlEditorTheme";
import { useSettingsStore } from "../../../stores/settingsStore";
import {
  createTablePreviewQueryCompletionSource,
  type TablePreviewQueryMode,
} from "./tablePreviewQueryCompletion";

export interface TablePreviewQuerySqlInputProps {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onFocusChange?: (focused: boolean) => void;
  mode: TablePreviewQueryMode;
  columnMeta?: DbColumnMeta[];
  dbType: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * 表数据查询栏单行 SQL 输入：CodeMirror + 字段/关键词补全。
 * 主题/字体/高亮/补全浮层与主 SQL 编辑器一致；布局为紧凑单行。
 */
export function TablePreviewQuerySqlInput({
  value,
  onChange,
  onCommit,
  onCancel,
  onFocusChange,
  mode,
  columnMeta,
  dbType,
  placeholder,
  disabled = false,
  className,
  "aria-label": ariaLabel,
}: TablePreviewQuerySqlInputProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const columnsRef = useRef(columnMeta);
  const modeRef = useRef(mode);
  const callbacksRef = useRef({ onChange, onCommit, onCancel, onFocusChange });
  const valueRef = useRef(value);
  const blurCommitTimerRef = useRef<number | null>(null);
  const languageCompartment = useRef(new Compartment()).current;
  const themeCompartment = useRef(new Compartment()).current;
  const readOnlyCompartment = useRef(new Compartment()).current;
  const placeholderCompartment = useRef(new Compartment()).current;

  const sqlKeywordCase = useSettingsStore((s) => s.sqlKeywordCase);
  const sqlEditorFontFamily = useSettingsStore((s) => s.sqlEditorFontFamily);
  const sqlEditorFontSize = useSettingsStore((s) => s.sqlEditorFontSize);
  const sqlEditorLineHeight = useSettingsStore((s) => s.sqlEditorLineHeight);

  columnsRef.current = columnMeta;
  modeRef.current = mode;
  valueRef.current = value;
  callbacksRef.current = { onChange, onCommit, onCancel, onFocusChange };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const clearBlurTimer = () => {
      if (blurCommitTimerRef.current != null) {
        window.clearTimeout(blurCommitTimerRef.current);
        blurCommitTimerRef.current = null;
      }
    };

    const keywordUpper = useSettingsStore.getState().sqlKeywordCase === "upper";
    const dialect = resolveSqlDialect(dbType);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          drawSelection(),
          history(),
          languageCompartment.of(
            sql({ dialect: dialect.cmDialect, upperCaseKeywords: keywordUpper }),
          ),
          readOnlyCompartment.of(EditorState.readOnly.of(disabled)),
          themeCompartment.of(
            getSqlInlineInputThemeExtensions(isLightTheme(), getSqlEditorTypographyFromStore()),
          ),
          // 补全挂到 body，避免被表数据面板 overflow:hidden 裁切
          tooltips({ parent: document.body }),
          placeholderCompartment.of(cmPlaceholder(placeholder ?? "")),
          autocompletion({
            activateOnTyping: true,
            maxRenderedOptions: 40,
            icons: true,
            optionClass: (completion) =>
              `cm-sql-completion cm-sql-completion--${completion.type ?? "text"}`,
            override: [
              createTablePreviewQueryCompletionSource(
                () => columnsRef.current,
                () => modeRef.current,
              ),
            ],
          }),
          EditorState.transactionFilter.of((tr) => {
            if (!tr.docChanged) return tr;
            let hasNewline = false;
            tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
              if (inserted.toString().includes("\n")) hasNewline = true;
            });
            if (!hasNewline && tr.newDoc.lines <= 1) return tr;
            return [
              tr,
              {
                changes: {
                  from: 0,
                  to: tr.newDoc.length,
                  insert: tr.newDoc.toString().replace(/\r?\n/g, " "),
                },
                sequential: true,
              },
            ];
          }),
          keymap.of([
            {
              // 单行查询栏：Enter 一律提交当前文本；不用来接受补全（避免误插入选项）
              key: "Enter",
              run: (v) => {
                if (completionStatus(v.state) === "active") {
                  closeCompletion(v);
                }
                clearBlurTimer();
                callbacksRef.current.onCommit();
                v.contentDOM.blur();
                return true;
              },
            },
            {
              key: "Tab",
              run: (v) => {
                if (completionStatus(v.state) === "active") {
                  return acceptCompletion(v);
                }
                return false;
              },
            },
            {
              key: "Escape",
              run: (v) => {
                if (completionStatus(v.state) === "active") {
                  closeCompletion(v);
                  return true;
                }
                clearBlurTimer();
                callbacksRef.current.onCancel();
                v.contentDOM.blur();
                return true;
              },
            },
            ...completionKeymap.filter(
              (b) => b.key !== "Enter" && b.key !== "Tab" && b.key !== "Escape",
            ),
            ...historyKeymap,
            ...defaultKeymap.filter((b) => b.key !== "Enter" && b.key !== "Escape"),
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              callbacksRef.current.onChange(update.state.doc.toString());
            }
          }),
          EditorView.domEventHandlers({
            focus: () => {
              clearBlurTimer();
              callbacksRef.current.onFocusChange?.(true);
              return false;
            },
            blur: () => {
              clearBlurTimer();
              blurCommitTimerRef.current = window.setTimeout(() => {
                blurCommitTimerRef.current = null;
                const current = viewRef.current;
                if (!current || current.hasFocus) return;
                if (completionStatus(current.state) === "active") return;
                callbacksRef.current.onFocusChange?.(false);
                callbacksRef.current.onCommit();
              }, 120);
              return false;
            },
          }),
          EditorView.contentAttributes.of({
            "aria-label": ariaLabel ?? "",
            spellcheck: "false",
          }),
        ],
      }),
    });

    viewRef.current = view;

    const onThemeAttr = () => {
      const current = viewRef.current;
      if (!current) return;
      current.dispatch({
        effects: themeCompartment.reconfigure(
          getSqlInlineInputThemeExtensions(isLightTheme(), getSqlEditorTypographyFromStore()),
        ),
      });
    };
    const themeObserver = new MutationObserver(onThemeAttr);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });

    return () => {
      clearBlurTimer();
      themeObserver.disconnect();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const dialect = resolveSqlDialect(dbType);
    view.dispatch({
      effects: languageCompartment.reconfigure(
        sql({
          dialect: dialect.cmDialect,
          upperCaseKeywords: sqlKeywordCase === "upper",
        }),
      ),
    });
  }, [dbType, languageCompartment, sqlKeywordCase]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(
        getSqlInlineInputThemeExtensions(isLightTheme(), {
          fontFamily: sqlEditorFontFamily,
          fontSize: sqlEditorFontSize,
          lineHeight: sqlEditorLineHeight,
        }),
      ),
    });
  }, [
    sqlEditorFontFamily,
    sqlEditorFontSize,
    sqlEditorLineHeight,
    themeCompartment,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(disabled)),
    });
  }, [disabled, readOnlyCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: placeholderCompartment.reconfigure(cmPlaceholder(placeholder ?? "")),
    });
  }, [placeholder, placeholderCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.hasFocus) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={["db-table-query-cm", className].filter(Boolean).join(" ")}
    />
  );
}
