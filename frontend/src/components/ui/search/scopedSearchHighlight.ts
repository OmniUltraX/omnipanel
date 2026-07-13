import {
  getTextSearchMatchIndices,
  splitTextByMatchIndices,
} from "../../../lib/textSearchMatch";

const MARK_CLASS = "scoped-search-mark";

const SKIP_SELECTOR =
  ".scoped-search-bar, input, textarea, select, option, script, style, .cm-editor, .sql-codemirror-editor, [contenteditable='true']";

function shouldSkipTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) {
    return true;
  }
  if (parent.closest(SKIP_SELECTOR)) {
    return true;
  }
  if (parent.classList.contains(MARK_CLASS)) {
    return true;
  }
  return false;
}

function collectTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || shouldSkipTextNode(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.textContent?.trim()) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

/** 清除宿主内由区域搜索产生的高亀mark　*/
export function clearScopedSearchHighlights(root: HTMLElement): void {
  root.querySelectorAll(`mark.${MARK_CLASS}`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) {
      return;
    }
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
  });
  root.normalize();
}

/** 在宿一DOM 内为匹配 query 的文本片段包裹高亀mark（支持拼音与原文）　*/
export function applyScopedSearchHighlights(root: HTMLElement, query: string): void {
  clearScopedSearchHighlights(root);

  const needle = query.trim();
  if (!needle) {
    return;
  }

  for (const textNode of collectTextNodes(root)) {
    const text = textNode.textContent ?? "";
    const indices = getTextSearchMatchIndices(text, needle);
    if (indices.length === 0) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    for (const part of splitTextByMatchIndices(text, indices)) {
      if (part.matched) {
        const mark = document.createElement("mark");
        mark.className = MARK_CLASS;
        mark.textContent = part.text;
        fragment.appendChild(mark);
      } else {
        fragment.appendChild(document.createTextNode(part.text));
      }
    }

    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}
