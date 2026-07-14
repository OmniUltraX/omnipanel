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

/** 清除宿主内由区域搜索产生的高亮 mark */
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

/** 将首个匹配滚动进可见区，并标记为当前命中 */
export function scrollScopedSearchMatchIntoView(root: HTMLElement): void {
  root
    .querySelectorAll(`mark.${MARK_CLASS}.is-current`)
    .forEach((mark) => mark.classList.remove("is-current"));
  const first = root.querySelector(`mark.${MARK_CLASS}`) as HTMLElement | null;
  if (!first) {
    return;
  }
  first.classList.add("is-current");
  first.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
}

/**
 * 在宿主 DOM 内为匹配 query 的文本片段包裹高亮 mark（支持拼音与原文）。
 * @returns 本次是否产生了匹配高亮
 */
export function applyScopedSearchHighlights(root: HTMLElement, query: string): boolean {
  clearScopedSearchHighlights(root);

  const needle = query.trim();
  if (!needle) {
    return false;
  }

  let matched = false;
  for (const textNode of collectTextNodes(root)) {
    const text = textNode.textContent ?? "";
    const indices = getTextSearchMatchIndices(text, needle);
    if (indices.length === 0) {
      continue;
    }

    matched = true;
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
  return matched;
}
