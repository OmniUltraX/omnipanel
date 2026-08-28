import { useCallback, useEffect, useState } from "react";
import {
  readTeamLocalStorage,
  TEAM_PERSIST_SCOPE_CHANGED_EVENT,
  writeTeamLocalStorage,
} from "../../../lib/teamPersist";

const STORAGE_KEY = "omnipanel-ssh-tree-expanded.v1";

function readExpanded(): Record<string, boolean> {
  try {
    const raw = readTeamLocalStorage(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeExpanded(next: Record<string, boolean>) {
  writeTeamLocalStorage(STORAGE_KEY, JSON.stringify(next));
}

export function usePersistedSshTreeExpanded() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(readExpanded);

  useEffect(() => {
    const onScopeChange = () => setExpanded(readExpanded());
    window.addEventListener(TEAM_PERSIST_SCOPE_CHANGED_EVENT, onScopeChange);
    return () => window.removeEventListener(TEAM_PERSIST_SCOPE_CHANGED_EVENT, onScopeChange);
  }, []);

  const isExpanded = useCallback(
    (key: string, defaultExpanded = false) => expanded[key] ?? defaultExpanded,
    [expanded],
  );

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
