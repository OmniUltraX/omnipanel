import { useEffect, useMemo, useRef, useState } from "react";
import type { CompletionCandidate, TerminalCompletionContext } from "./types";
import { suggestHistory } from "./providers/historyProvider";
import { suggestTemplates } from "./providers/templateProvider";
import {
  suggestPaths,
  suggestPathsCached,
  suggestWorkspaceResources,
} from "./providers/pathProvider";

function mergeCandidates(lists: CompletionCandidate[][]): CompletionCandidate[] {
  const seen = new Set<string>();
  const high: CompletionCandidate[] = [];
  const normal: CompletionCandidate[] = [];

  for (const list of lists) {
    for (const item of list) {
      const key = `${item.source}:${item.insertText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (item.priority === "high") high.push(item);
      else normal.push(item);
    }
  }

  return [...high, ...normal].slice(0, 30);
}

interface UseCommandCompletionOptions {
  /** 浮层未打开时不做任何补全计算，避免连续输入卡顿 */
  enabled?: boolean;
  /** 仅在补全浮层打开时请求路径列表（配合目录缓存） */
  fetchPaths?: boolean;
}

/** 缓存未命中时的路径 IPC 防抖 */
const PATH_FETCH_DEBOUNCE_MS = 80;

export function useCommandCompletion(
  ctx: TerminalCompletionContext | null,
  options: UseCommandCompletionOptions = {},
) {
  const { fetchPaths = false, enabled = true } = options;
  const [candidates, setCandidates] = useState<CompletionCandidate[]>([]);
  const seqRef = useRef(0);

  const ctxKey = useMemo(
    () =>
      ctx
        ? `${ctx.sessionId}:${ctx.cwd}:${ctx.input}:${ctx.cursor}:${ctx.resourceId}:${fetchPaths}`
        : "",
    [ctx, fetchPaths],
  );

  useEffect(() => {
    if (!enabled) return;

    if (!ctx) {
      setCandidates([]);
      return;
    }

    const seq = ++seqRef.current;
    let cancelled = false;

    const syncLists = [
      suggestHistory(ctx),
      suggestTemplates(ctx),
      suggestWorkspaceResources(ctx),
    ];

    if (!fetchPaths) {
      setCandidates(mergeCandidates(syncLists));
      return;
    }

    const cachedPaths = suggestPathsCached(ctx);
    if (cachedPaths) {
      setCandidates(mergeCandidates([...syncLists, cachedPaths]));
      return;
    }

    // 缓存未命中：先展示同步候选，路径请求防抖合并
    setCandidates(mergeCandidates(syncLists));

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const paths = await suggestPaths(ctx);
          if (cancelled || seq !== seqRef.current) return;
          setCandidates(mergeCandidates([...syncLists, paths]));
        } catch {
          /* 保持同步候选 */
        }
      })();
    }, PATH_FETCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ctx, ctxKey, enabled, fetchPaths]);

  return { candidates };
}

export function applyCompletionCandidate(
  input: string,
  candidate: CompletionCandidate,
): { value: string; cursor: number } {
  const { start, end } = candidate.replacement;
  const before = input.slice(0, start);
  const after = input.slice(end);
  const needsSpace = after.length > 0 && !after.startsWith(" ") ? " " : "";
  const value = `${before}${candidate.insertText}${needsSpace}${after}`;
  const cursor = before.length + candidate.insertText.length + (needsSpace ? 1 : 0);
  return { value, cursor };
}
