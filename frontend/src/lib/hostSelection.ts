export type HostSelectionSource = "terminal" | "dom" | "editor";

export type HostSelection = {
  text: string;
  source: HostSelectionSource;
};

let terminalSelection = "";

export function setTerminalSelection(text: string): void {
  terminalSelection = text;
}

export function getHostSelection(): HostSelection | null {
  const term = terminalSelection.trim();
  if (term) {
    return { text: term, source: "terminal" };
  }
  const dom = typeof window !== "undefined" ? window.getSelection()?.toString().trim() ?? "" : "";
  if (dom) {
    return { text: dom, source: "dom" };
  }
  return null;
}

export const pluginHostSelection = {
  get: getHostSelection,
};
