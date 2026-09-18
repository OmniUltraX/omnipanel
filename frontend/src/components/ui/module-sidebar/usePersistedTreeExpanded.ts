import { useCallback, useEffect, useState } from "react";
import {
  readTeamLocalStorage,
  TEAM_PERSIST_SCOPE_CHANGED_EVENT,
  writeTeamLocalStorage,
} from "@/lib/teamPersist";

export type TreeExpandedPersistScope = "local" | "team";

function readMap(storageKey: string, scope: TreeExpandedPersistScope): Record<string, boolean> {
  try {
    const raw =
      scope === "team" ? readTeamLocalStorage(storageKey) : localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeMap(
  storageKey: string,
  scope: TreeExpandedPersistScope,
  next: Record<string, boolean>,
) {
  const raw = JSON.stringify(next);
  if (scope === "team") writeTeamLocalStorage(storageKey, raw);
  else localStorage.setItem(storageKey, raw);
}

/**
 * 树展开态统一 Hook：收敛 SSH / Docker / 终端三处同逻辑的 localStorage 实现。
 *
 * - `scope: "local"` 走本机 localStorage；`"team"` 走团队分桶并监听作用域切换；
 * - storageKey 迁移时必须沿用旧 key，避免丢失用户现有展开态；
 * - zustand / store 承载的展开态（数据库 schema 树、知识库）保持不动，
 *   它们已是同语义（team 持久化 + 快照），不在本 Hook 收敛范围。
 */
export function usePersistedTreeExpanded(
  storageKey: string,
  scope: TreeExpandedPersistScope = "local",
) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    readMap(storageKey, scope),
  );

  useEffect(() => {
    if (scope !== "team") return;
    const onScopeChange = () => setExpanded(readMap(storageKey, scope));
    window.addEventListener(TEAM_PERSIST_SCOPE_CHANGED_EVENT, onScopeChange);
    return () => window.removeEventListener(TEAM_PERSIST_SCOPE_CHANGED_EVENT, onScopeChange);
  }, [storageKey, scope]);

  const isExpanded = useCallback(
    (key: string, defaultExpanded = false) => expanded[key] ?? defaultExpanded,
    [expanded],
  );

  const toggle = useCallback(
    (key: string) => {
      setExpanded((prev) => {
        const next = { ...prev, [key]: !(prev[key] ?? false) };
        writeMap(storageKey, scope, next);
        return next;
      });
    },
    [storageKey, scope],
  );

  const ensureExpanded = useCallback(
    (key: string) => {
      setExpanded((prev) => {
        if (prev[key]) return prev;
        const next = { ...prev, [key]: true };
        writeMap(storageKey, scope, next);
        return next;
      });
    },
    [storageKey, scope],
  );

  const setAllExpanded = useCallback(
    (keys: Iterable<string>, nextExpanded: boolean) => {
      setExpanded((prev) => {
        const next = { ...prev };
        for (const key of keys) next[key] = nextExpanded;
        writeMap(storageKey, scope, next);
        return next;
      });
    },
    [storageKey, scope],
  );

  const collapseAll = useCallback(() => {
    setExpanded((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next: Record<string, boolean> = {};
      writeMap(storageKey, scope, next);
      return next;
    });
  }, [storageKey, scope]);

  return { isExpanded, toggle, ensureExpanded, setAllExpanded, collapseAll };
}
