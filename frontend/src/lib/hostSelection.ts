export type HostSelectionSource = "terminal" | "dom" | "editor";

export type HostSelection = {
  text: string;
  source: HostSelectionSource;
};

let terminalSelection = "";
let terminalAt = 0;
let domAt = 0;

export function setTerminalSelection(text: string): void {
  terminalSelection = text;
  if (text.trim()) terminalAt = Date.now();
}

function readDomSelection(): string {
  const dom = typeof window !== "undefined" ? window.getSelection()?.toString().trim() ?? "" : "";
  if (dom) domAt = Date.now();
  return dom;
}

export function getHostSelection(): HostSelection | null {
  const dom = readDomSelection();
  const term = terminalSelection.trim();
  // 新鲜度优先：后变化的来源胜出。终端选区常驻不清，固定终端优先会导致
  // "终端选过一次后文档选区永远被盖住"（悬浮按钮回文档不出）。
  // DOM 为空时回退常驻终端选区（overlay 打开后读选区的老链路不受影响）。
  if (dom && (!term || domAt >= terminalAt)) {
    return { text: dom, source: "dom" };
  }
  if (term) {
    return { text: term, source: "terminal" };
  }
  if (dom) {
    return { text: dom, source: "dom" };
  }
  return null;
}

export const pluginHostSelection = {
  get: getHostSelection,
};
