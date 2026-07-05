export type ScopedSearchEntry = {
  getRoot: () => HTMLElement | null;
  isEnabled: () => boolean;
  isVisible: () => boolean;
  onActivate: () => void;
  onEscape: () => void;
};

const entries = new Set<ScopedSearchEntry>();
let globalListenerAttached = false;

function isEntryScopeActive(entry: ScopedSearchEntry): boolean {
  const root = entry.getRoot();
  if (!root) {
    return false;
  }
  return root.contains(document.activeElement) || root.matches(":hover");
}

function pickDeepest(candidates: ScopedSearchEntry[]): ScopedSearchEntry {
  return candidates.reduce((best, cur) => {
    const bestRoot = best.getRoot();
    const curRoot = cur.getRoot();
    if (!bestRoot || !curRoot) {
      return cur;
    }
    if (bestRoot.contains(curRoot)) {
      return cur;
    }
    if (curRoot.contains(bestRoot)) {
      return best;
    }
    return cur;
  });
}

function pickScopedSearchEntry(): ScopedSearchEntry | null {
  const candidates = [...entries].filter((entry) => entry.isEnabled());
  if (candidates.length === 0) {
    return null;
  }

  const withFocus = candidates.filter((entry) => {
    const root = entry.getRoot();
    return root !== null && root.contains(document.activeElement);
  });
  if (withFocus.length > 0) {
    return pickDeepest(withFocus);
  }

  const withHover = candidates.filter((entry) => {
    const root = entry.getRoot();
    return root !== null && root.matches(":hover");
  });
  if (withHover.length > 0) {
    return pickDeepest(withHover);
  }

  return null;
}

function handleGlobalKeyDown(e: KeyboardEvent) {
  const isFind =
    (e.metaKey || e.ctrlKey) &&
    e.key.toLowerCase() === "f" &&
    !e.shiftKey &&
    !e.altKey;
  const isEscape = e.key === "Escape";

  if (!isFind && !isEscape) {
    return;
  }

  const target = pickScopedSearchEntry();
  if (!target || !isEntryScopeActive(target)) {
    return;
  }

  if (isFind) {
    e.preventDefault();
    e.stopPropagation();
    target.onActivate();
    return;
  }

  if (target.isVisible()) {
    e.preventDefault();
    e.stopPropagation();
    target.onEscape();
  }
}

function attachGlobalListener() {
  if (globalListenerAttached) {
    return;
  }
  globalListenerAttached = true;
  document.addEventListener("keydown", handleGlobalKeyDown, true);
}

function detachGlobalListenerIfEmpty() {
  if (entries.size === 0 && globalListenerAttached) {
    document.removeEventListener("keydown", handleGlobalKeyDown, true);
    globalListenerAttached = false;
  }
}

export function registerScopedSearch(entry: ScopedSearchEntry): () => void {
  entries.add(entry);
  attachGlobalListener();
  return () => {
    entries.delete(entry);
    detachGlobalListenerIfEmpty();
  };
}
