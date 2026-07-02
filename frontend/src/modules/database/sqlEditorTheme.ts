import { HighlightStyle, syntaxHighlighting, type Extension } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { sql } from "@codemirror/lang-sql";
import { resolveSqlDialect } from "./sqlIntel/sqlDialect";
import {
  DEFAULT_SQL_EDITOR_FONT_FAMILY,
  DEFAULT_SQL_EDITOR_FONT_SIZE,
  DEFAULT_SQL_EDITOR_LINE_HEIGHT,
  useSettingsStore,
} from "../../stores/settingsStore";

export interface SqlEditorTypography {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

export function getSqlEditorTypographyFromStore(): SqlEditorTypography {
  const state = useSettingsStore.getState();
  return {
    fontFamily: state.sqlEditorFontFamily,
    fontSize: state.sqlEditorFontSize,
    lineHeight: state.sqlEditorLineHeight,
  };
}

function sqlEditorFontStack(fontFamily: string): string {
  const primary = fontFamily.trim() || DEFAULT_SQL_EDITOR_FONT_FAMILY;
  return `"${primary}", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace`;
}

function typographyContentStyles(typography: SqlEditorTypography) {
  const fontStack = sqlEditorFontStack(typography.fontFamily);
  return {
    fontFamily: fontStack,
    fontSize: `${typography.fontSize}px`,
    lineHeight: String(typography.lineHeight),
  };
}

const darkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#007aff", fontWeight: "bold" },
  { tag: t.operator, color: "#fdfcfc" },
  { tag: t.string, color: "#30d158" },
  { tag: t.number, color: "#ff9f0a" },
  { tag: t.comment, color: "#6e6e73", fontStyle: "italic" },
  { tag: t.typeName, color: "#007aff" },
  { tag: t.variableName, color: "#fdfcfc" },
  { tag: t.propertyName, color: "#c8c6c4" },
  { tag: t.definition(t.propertyName), color: "#ff9f0a" },
  { tag: t.function(t.variableName), color: "#ff9f0a" },
]);

const lightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#007aff", fontWeight: "bold" },
  { tag: t.operator, color: "#1d1d1f" },
  { tag: t.string, color: "#34c759" },
  { tag: t.number, color: "#ff9500" },
  { tag: t.comment, color: "#aeaeb2", fontStyle: "italic" },
  { tag: t.typeName, color: "#007aff" },
  { tag: t.variableName, color: "#1d1d1f" },
  { tag: t.propertyName, color: "#424245" },
  { tag: t.definition(t.propertyName), color: "#ff9500" },
  { tag: t.function(t.variableName), color: "#ff9500" },
]);

const sharedAutocompleteTheme = {
  ".cm-tooltip": {
    backgroundColor: "var(--surface)",
    border: "1px solid var(--border)",
    color: "var(--fg)",
    borderRadius: "8px",
    boxShadow:
      "0 10px 28px color-mix(in srgb, #000 24%, transparent), 0 0 0 1px color-mix(in srgb, var(--border) 40%, transparent)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete": {
    padding: 0,
    minWidth: "220px",
    maxWidth: "min(520px, 92vw)",
  },
  ".cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-ui)",
    fontSize: "12px",
    lineHeight: "1.35",
    maxHeight: "min(320px, 42vh)",
    overflowY: "auto",
    overflowX: "hidden",
    margin: 0,
    padding: "6px",
    listStyle: "none",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 8px",
    margin: 0,
    borderRadius: "6px",
    cursor: "default",
    transition: "background-color 0.1s ease, color 0.1s ease",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--fg)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail": {
    color: "var(--fg-2)",
  },
  ".cm-completionIcon": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    height: "20px",
    flexShrink: 0,
    borderRadius: "5px",
    fontSize: "9px",
    fontWeight: 700,
    fontFamily: "var(--font-ui)",
    letterSpacing: "-0.02em",
    lineHeight: 1,
    backgroundColor: "var(--bg-deeper)",
    border: "1px solid var(--border-soft)",
    color: "var(--muted)",
    opacity: 1,
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionIcon": {
    backgroundColor: "color-mix(in srgb, var(--accent) 18%, var(--surface))",
    borderColor: "color-mix(in srgb, var(--accent) 35%, var(--border))",
    color: "var(--accent)",
  },
  ".cm-completionIcon-keyword": {
    color: "var(--accent)",
  },
  ".cm-completionIcon-function": {
    color: "#bf5af2",
  },
  ".cm-completionIcon-class": {
    color: "var(--warn)",
  },
  ".cm-completionIcon-property": {
    color: "var(--success)",
  },
  ".cm-completionIcon-namespace": {
    color: "var(--muted)",
  },
  ".cm-completionLabel": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    fontWeight: 500,
    flex: "1 1 auto",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-completionDetail": {
    fontFamily: "var(--font-ui)",
    fontSize: "11px",
    color: "var(--meta)",
    flex: "0 1 auto",
    maxWidth: "55%",
    marginLeft: "auto",
    paddingLeft: "12px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    opacity: 0.92,
  },
  ".cm-completionMatchedText": {
    color: "var(--accent)",
    fontWeight: 700,
    textDecoration: "none",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText": {
    color: "var(--accent-hover)",
  },
};

function createDarkTheme(typography: SqlEditorTypography) {
  const contentTypography = typographyContentStyles(typography);
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "#1a1717",
        color: "#fdfcfc",
        cursor: "text",
      },
      ".cm-content": {
        caretColor: "#fdfcfc",
        cursor: "text",
        padding: "12px 0",
        ...contentTypography,
      },
      ".cm-scroller": { overflow: "auto", cursor: "text" },
      ".cm-gutters": {
        backgroundColor: "#1a1717",
        color: "#6e6e73",
        border: "none",
        cursor: "default",
        ...contentTypography,
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#fdfcfc" },
      ".cm-selectionBackground": {
        backgroundColor: "#007aff20 !important",
      },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor: "#007aff40 !important",
      },
      ".cm-content ::selection": {
        backgroundColor: "#007aff40 !important",
      },
      ".cm-selectionMatch, &.cm-focused .cm-selectionMatch": {
        backgroundColor: "transparent !important",
      },
      ".cm-activeLine": { backgroundColor: "#302c2c40" },
      ".cm-activeLineGutter": { color: "#c8c6c4" },
      ".cm-editor": { position: "relative" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "2.5em" },
      ".cm-gutter-lint": {
        minWidth: "2.2em",
      },
      ".cm-gutter-lint .cm-gutterElement": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "2px",
        padding: "0 2px",
      },
      ".cm-sql-lint-run-cell": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "2px",
      },
      ".cm-sql-run-button": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "22px",
        height: "22px",
        padding: "0",
        border: "none",
        borderRadius: "4px",
        backgroundColor: "transparent",
        color: "#66bb6a",
        cursor: "pointer",
        opacity: "0.55",
      },
      ".cm-sql-run-button svg": {
        width: "16px",
        height: "16px",
      },
      ".cm-sql-run-gutter-spacer svg": {
        width: "16px",
        height: "16px",
        visibility: "hidden",
      },
      ".cm-sql-run-button:hover": {
        opacity: "1",
        backgroundColor: "color-mix(in srgb, #66bb6a 18%, transparent)",
      },
      ".cm-sql-run-button:focus-visible": {
        opacity: "1",
        outline: "1px solid #66bb6a",
        outlineOffset: "1px",
      },
      ".cm-foldGutter .cm-gutterElement": { padding: "0 4px" },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: "transparent",
        outline: "none",
      },
      ".cm-lintRange-active": {
        backgroundColor: "transparent !important",
      },
      ".cm-search-highlight": {
        backgroundColor: "color-mix(in srgb, var(--warn) 35%, transparent)",
        borderRadius: "2px",
      },
      ...sharedAutocompleteTheme,
      ".cm-sql-function-signature": {
        position: "sticky",
        top: "0",
        zIndex: "2",
        margin: "0 0 4px 0",
        padding: "4px 8px",
        fontSize: "12px",
        lineHeight: "1.4",
        backgroundColor: "color-mix(in srgb, var(--accent) 12%, var(--surface-elevated))",
        borderBottom: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
        color: "var(--text-secondary)",
        fontFamily: "inherit",
      },
      ".cm-sql-signature-name": { color: "var(--accent)", fontWeight: "600" },
      ".cm-sql-signature-param--active": { color: "var(--text-primary)", textDecoration: "underline" },
      ".cm-sql-function-signature__desc": {
        marginLeft: "8px",
        opacity: "0.85",
      },
    },
    { dark: true },
  );
}

function createLightTheme(typography: SqlEditorTypography) {
  const contentTypography = typographyContentStyles(typography);
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "#e8e8ed",
        color: "#1d1d1f",
        cursor: "text",
      },
      ".cm-content": {
        caretColor: "#1d1d1f",
        cursor: "text",
        padding: "12px 0",
        ...contentTypography,
      },
      ".cm-scroller": { overflow: "auto", cursor: "text" },
      ".cm-gutters": {
        backgroundColor: "#e8e8ed",
        color: "#aeaeb2",
        border: "none",
        cursor: "default",
        ...contentTypography,
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#1d1d1f" },
      ".cm-selectionBackground": {
        backgroundColor: "#007aff18 !important",
      },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor: "#007aff30 !important",
      },
      ".cm-content ::selection": {
        backgroundColor: "#007aff30 !important",
      },
      ".cm-selectionMatch, &.cm-focused .cm-selectionMatch": {
        backgroundColor: "transparent !important",
      },
      ".cm-activeLine": { backgroundColor: "#ffffff60" },
      ".cm-activeLineGutter": { color: "#424245" },
      ".cm-editor": { position: "relative" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "2.5em" },
      ".cm-gutter-lint": {
        minWidth: "2.2em",
      },
      ".cm-gutter-lint .cm-gutterElement": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "2px",
        padding: "0 2px",
      },
      ".cm-sql-lint-run-cell": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "2px",
      },
      ".cm-sql-run-button": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "22px",
        height: "22px",
        padding: "0",
        border: "none",
        borderRadius: "4px",
        backgroundColor: "transparent",
        color: "#66bb6a",
        cursor: "pointer",
        opacity: "0.55",
      },
      ".cm-sql-run-button svg": {
        width: "16px",
        height: "16px",
      },
      ".cm-sql-run-gutter-spacer svg": {
        width: "16px",
        height: "16px",
        visibility: "hidden",
      },
      ".cm-sql-run-button:hover": {
        opacity: "1",
        backgroundColor: "color-mix(in srgb, #66bb6a 18%, transparent)",
      },
      ".cm-sql-run-button:focus-visible": {
        opacity: "1",
        outline: "1px solid #66bb6a",
        outlineOffset: "1px",
      },
      ".cm-foldGutter .cm-gutterElement": { padding: "0 4px" },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: "transparent",
        outline: "none",
      },
      ".cm-lintRange-active": {
        backgroundColor: "transparent !important",
      },
      ".cm-search-highlight": {
        backgroundColor: "color-mix(in srgb, var(--warn) 35%, transparent)",
        borderRadius: "2px",
      },
      ...sharedAutocompleteTheme,
      ".cm-sql-function-signature": {
        position: "sticky",
        top: "0",
        zIndex: "2",
        margin: "0 0 4px 0",
        padding: "4px 8px",
        fontSize: "12px",
        lineHeight: "1.4",
        backgroundColor: "color-mix(in srgb, var(--accent) 10%, var(--surface-elevated))",
        borderBottom: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
        color: "var(--text-secondary)",
        fontFamily: "inherit",
      },
      ".cm-sql-signature-name": { color: "var(--accent)", fontWeight: "600" },
      ".cm-sql-signature-param--active": { color: "var(--text-primary)", textDecoration: "underline" },
      ".cm-sql-function-signature__desc": {
        marginLeft: "8px",
        opacity: "0.85",
      },
    },
    { dark: false },
  );
}

export function getSqlEditorThemeExtensions(
  isLight: boolean,
  typography: SqlEditorTypography = getSqlEditorTypographyFromStore(),
) {
  return [
    isLight ? createLightTheme(typography) : createDarkTheme(typography),
    syntaxHighlighting(isLight ? lightHighlight : darkHighlight),
  ];
}

/** Hover 浮层等只读 SQL 片段：与主编辑器同色高亮，透明底、无行号。 */
export function getSqlSnippetHighlightExtensions(dbType?: string | null): Extension[] {
  const isLight = isLightTheme();
  const profile = resolveSqlDialect(dbType);
  return [
    sql({ dialect: profile.cmDialect, upperCaseKeywords: true }),
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
    syntaxHighlighting(isLight ? lightHighlight : darkHighlight),
    EditorView.contentAttributes.of({ class: "db-sql-hover-cm-content" }),
    EditorView.theme(
      {
        "&": {
          backgroundColor: "transparent",
          color: "inherit",
        },
        ".cm-editor": {
          outline: "none",
          cursor: "text",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          lineHeight: "1.5",
          cursor: "text",
        },
        ".cm-content": {
          padding: "8px 10px",
          caretColor: "transparent",
          cursor: "text",
        },
        ".cm-line": {
          cursor: "text",
        },
        ".cm-gutters": { display: "none !important" },
        ".cm-activeLine": { backgroundColor: "transparent !important" },
        ".cm-cursor, .cm-dropCursor": { display: "none !important" },
        ".cm-selectionBackground": {
          backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent) !important",
        },
      },
      { dark: !isLight },
    ),
  ];
}

export function isLightTheme(): boolean {
  return document.documentElement.getAttribute("data-theme") === "light";
}

/** 设置页 SQL 编辑器预览用默认排版。 */
export function defaultSqlEditorTypography(): SqlEditorTypography {
  return {
    fontFamily: DEFAULT_SQL_EDITOR_FONT_FAMILY,
    fontSize: DEFAULT_SQL_EDITOR_FONT_SIZE,
    lineHeight: DEFAULT_SQL_EDITOR_LINE_HEIGHT,
  };
}
