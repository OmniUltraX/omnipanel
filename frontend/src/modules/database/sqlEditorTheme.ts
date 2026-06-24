import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { EditorView } from "@codemirror/view";

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

const darkTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#1a1717",
      color: "#fdfcfc",
    },
    ".cm-content": {
      caretColor: "#fdfcfc",
      padding: "12px 0",
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      lineHeight: "22px",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#fdfcfc" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#007aff30 !important",
    },
    ".cm-activeLine": { backgroundColor: "#302c2c40" },
    ".cm-gutters": {
      backgroundColor: "#1a1717",
      color: "#6e6e73",
      border: "none",
    },
    ".cm-activeLineGutter": { color: "#c8c6c4" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "2.5em" },
    ".cm-foldGutter .cm-gutterElement": { padding: "0 4px" },
    ".cm-scroller": { overflow: "auto" },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "#007aff20",
      outline: "1px solid #007aff50",
    },
    ".cm-search-highlight": {
      backgroundColor: "color-mix(in srgb, var(--warn) 35%, transparent)",
      borderRadius: "2px",
    },
    ...sharedAutocompleteTheme,
  },
  { dark: true },
);

const lightTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#e8e8ed",
      color: "#1d1d1f",
    },
    ".cm-content": {
      caretColor: "#1d1d1f",
      padding: "12px 0",
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      lineHeight: "22px",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#1d1d1f" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#007aff20 !important",
    },
    ".cm-activeLine": { backgroundColor: "#ffffff60" },
    ".cm-gutters": {
      backgroundColor: "#e8e8ed",
      color: "#aeaeb2",
      border: "none",
    },
    ".cm-activeLineGutter": { color: "#424245" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "2.5em" },
    ".cm-foldGutter .cm-gutterElement": { padding: "0 4px" },
    ".cm-scroller": { overflow: "auto" },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "#007aff15",
      outline: "1px solid #007aff40",
    },
    ".cm-search-highlight": {
      backgroundColor: "color-mix(in srgb, var(--warn) 35%, transparent)",
      borderRadius: "2px",
    },
    ...sharedAutocompleteTheme,
  },
  { dark: false },
);

export function getSqlEditorThemeExtensions(isLight: boolean) {
  return [
    isLight ? lightTheme : darkTheme,
    syntaxHighlighting(isLight ? lightHighlight : darkHighlight),
  ];
}

export function isLightTheme(): boolean {
  return document.documentElement.getAttribute("data-theme") === "light";
}
