import { useEffect, useMemo, useState } from "react";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { EMPTY_TAG_IDS, useTagUiStore } from "./tagStore";

/**
 * 订阅模块标签筛选：返回允许的 resourceId 集合；无筛选时为 null。
 */
export function useModuleTagFilter(
  moduleKey: string,
  kinds: readonly string[],
): Set<string> | null {
  const selectedTagIds = useTagUiStore(
    (s) => s.selectedByModule[moduleKey] ?? EMPTY_TAG_IDS,
  );
  const matchMode = useTagUiStore((s) => s.matchModes[moduleKey] ?? "and");
  const [allowedIds, setAllowedIds] = useState<Set<string> | null>(null);
  const kindsKey = useMemo(() => kinds.join("\0"), [kinds]);

  useEffect(() => {
    if (selectedTagIds.length === 0) {
      setAllowedIds((prev) => (prev === null ? prev : null));
      return;
    }
    let cancelled = false;
    const kindList = kindsKey ? kindsKey.split("\0") : [];
    void unwrapCommand(
      commands.tagQueryResources(selectedTagIds, matchMode, kindList, true),
    )
      .then((rows) => {
        if (!cancelled) {
          setAllowedIds(new Set(rows.map((r) => r.resourceId)));
        }
      })
      .catch(() => {
        if (!cancelled) setAllowedIds(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTagIds, matchMode, kindsKey]);

  return allowedIds;
}

/** 无筛选时通过；有筛选时 id 必须在集合内 */
export function passTagFilter(
  allowedIds: Set<string> | null,
  resourceId: string,
): boolean {
  if (!allowedIds) return true;
  return allowedIds.has(resourceId);
}
