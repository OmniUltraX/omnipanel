import { useCallback, useState } from "react";

const STORAGE_KEY = "omnipanel-server-tree-expanded.v1";

function readExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeExpanded(next: Record<string, boolean>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function usePersistedServerTreeExpanded() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(readExpanded);

  const isExpanded = useCallback((key: string) => expanded[key] ?? false, [expanded]);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writeExpanded(next);
      return next;
    });
  }, []);

  const ensureExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      if (prev[key]) return prev;
      const next = { ...prev, [key]: true };
      writeExpanded(next);
      return next;
    });
  }, []);

  return { isExpanded, toggle, ensureExpanded };
}
