import {
  openSearchPanel,
  search,
  searchKeymap,
  highlightSelectionMatches,
} from "@codemirror/search";
import { EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { t } from "../../../i18n";

/**
 * CodeMirror 搜索面板 phrase 键（与 @codemirror/search 内 state.phrase(...) 一致）。
 * 见 node_modules/@codemirror/search 的 SearchPanel。
 */
function buildEditorSearchPhrases(): Record<string, string> {
  return {
    Find: t("ui.editorSearch.find"),
    Replace: t("ui.editorSearch.replace"),
    next: t("ui.editorSearch.next"),
    previous: t("ui.editorSearch.previous"),
    all: t("ui.editorSearch.all"),
    "match case": t("ui.editorSearch.matchCase"),
    regexp: t("ui.editorSearch.regexp"),
    "by word": t("ui.editorSearch.byWord"),
    replace: t("ui.editorSearch.replaceOne"),
    "replace all": t("ui.editorSearch.replaceAll"),
    close: t("ui.editorSearch.close"),
    "current match": t("ui.editorSearch.currentMatch"),
    "on line": t("ui.editorSearch.onLine"),
    "Go to line": t("ui.editorSearch.goToLine"),
    go: t("ui.editorSearch.go"),
    "replaced match on line $": t("ui.editorSearch.replacedMatchOnLine"),
    "replaced $ matches": t("ui.editorSearch.replacedMatches"),
  };
}

/**
 * CodeMirror 统一查找/替换扩展。
 * - 可编辑：完整 Find + Replace
 * - 只读：仍可查找；替换操作因 EditorState.readOnly 不会改写文档
 */
export function createEditorSearchExtensions(): Extension[] {
  return [
    search({ top: true }),
    highlightSelectionMatches(),
    EditorState.phrases.of(buildEditorSearchPhrases()),
    // 高于 SqlEditor 后续 defaultKeymap，确保 Mod-f 落到 searchKeymap
    Prec.high(keymap.of(searchKeymap)),
  ];
}

/** 焦点是否在 CodeMirror 编辑器（含搜索面板输入框）内 */
export function isCodeMirrorEditorFocused(
  target: EventTarget | null = document.activeElement,
): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(".cm-editor"));
}

/**
 * 在捕获阶段打开当前焦点 CM 的搜索面板。
 * 用于抢在 WebView 原生查找 / 终端全局 Mod+F 之前处理。
 */
export function tryOpenFocusedEditorSearch(): boolean {
  const el = document.activeElement;
  if (!(el instanceof Element)) return false;
  const root = el.closest(".cm-editor");
  if (!(root instanceof HTMLElement)) return false;
  const view = EditorView.findFromDOM(root);
  if (!view) return false;
  openSearchPanel(view);
  return true;
}
