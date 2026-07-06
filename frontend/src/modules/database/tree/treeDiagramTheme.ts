export interface TreeDiagramTheme {
  canvasBg: string;
  rootFill: string;
  rootStroke: string;
  rootLabelFill: string;
  nodeFill: string;
  nodeStroke: string;
  labelFill: string;
  edgeFallback: string;
}

function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

export function readTreeDiagramTheme(el: HTMLElement): TreeDiagramTheme {
  return {
    canvasBg: cssVar(el, "--bg", "#201d1d"),
    rootFill: cssVar(el, "--surface", "#302c2c"),
    rootStroke: cssVar(el, "--border", "#464343"),
    rootLabelFill: cssVar(el, "--fg", "#fdfcfc"),
    nodeFill: cssVar(el, "--surface", "#302c2c"),
    nodeStroke: cssVar(el, "--border-soft", "#302c2c"),
    labelFill: cssVar(el, "--fg-2", "#c8c6c4"),
    edgeFallback: cssVar(el, "--meta", "#6e6e73"),
  };
}

export function watchTreeDiagramTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}
