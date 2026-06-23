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
    ".cm-tooltip": {
      backgroundColor: "#302c2c",
      border: "1px solid #464343",
      color: "#fdfcfc",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        backgroundColor: "#007aff25",
        color: "#fdfcfc",
      },
    },
    ".cm-search-highlight": {
      backgroundColor: "color-mix(in srgb, var(--warn) 35%, transparent)",
      borderRadius: "2px",
    },
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
    ".cm-tooltip": {
      backgroundColor: "#ffffff",
      border: "1px solid #d2d2d7",
      color: "#1d1d1f",
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": {
        backgroundColor: "#007aff18",
        color: "#1d1d1f",
      },
    },
    ".cm-search-highlight": {
      backgroundColor: "color-mix(in srgb, var(--warn) 35%, transparent)",
      borderRadius: "2px",
    },
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
