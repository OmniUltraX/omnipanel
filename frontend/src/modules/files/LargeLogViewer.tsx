import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n } from "../../i18n";
import { fmtError, formatFileSize } from "./utils";
import {
  openLogSession,
  readLogLines,
  readLogTailInitial,
  searchLog,
  startLogTail,
  stopLogTail,
} from "./logApi";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { LogSearchHit, LogSessionInfo } from "../../ipc/bindings";

const ROW_HEIGHT = 20;
const CHUNK_SIZE = 200;
const MAX_LOADED_CHUNKS = 60; // LRU 上限：60 * 200 = 12000 行常驻内存
const TAIL_INITIAL_LINES = 200; // 跟踪启动时先输出末尾 200 行作为上下文

/** 超过该体积或行数时走末尾窗口模式，避免 sed 全文件扫描 */
const WINDOW_SIZE_THRESHOLD = 100 * 1024 * 1024; // 100MB
const WINDOW_LINES_THRESHOLD = 500_000;
const WINDOW_INITIAL = 500;
const WINDOW_MAX = 20_000;
const WINDOW_LOAD_MORE = 2_000;

interface LargeLogViewerProps {
  /** SSH 资源 id（交互式会话或连接池资源 id） */
  sshId: string;
  /** 远端文件绝对路径 */
  path: string;
  className?: string;
}

function shouldUseWindowMode(info: LogSessionInfo): boolean {
  if (info.linesEstimated) return true;
  if (info.totalLines == null) return true;
  const size = info.sizeBytes ?? 0;
  if (size > WINDOW_SIZE_THRESHOLD) return true;
  if ((info.totalLines ?? 0) > WINDOW_LINES_THRESHOLD) return true;
  return false;
}

/**
 * 大日志文件流式预览器（>10MB）。
 *
 * - 小/中文件：虚拟滚动按需 sed 切片 + chunk LRU
 * - 超大文件 / 行数估算：末尾窗口模式（tail），支持加载更多历史、跟踪、搜索
 */
export function LargeLogViewer({ sshId, path, className }: LargeLogViewerProps) {
  const { t } = useI18n();

  // ---- 行数据：用 Map<lineNo, text> 支持稀疏加载 ----
  const linesRef = useRef<Map<number, string>>(new Map());
  const loadedChunksRef = useRef<Set<string>>(new Set());
  const chunkLruRef = useRef<string[]>([]);
  const inflightChunksRef = useRef<Set<string>>(new Set());

  // ---- 会话与状态 ----
  const [sessionInfo, setSessionInfo] = useState<LogSessionInfo | null>(null);
  const [totalLines, setTotalLines] = useState<number>(0);
  const [windowMode, setWindowMode] = useState(false);
  const [windowSize, setWindowSize] = useState(WINDOW_INITIAL);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((v) => v + 1), []);

  // ---- 跟踪 ----
  const [following, setFollowing] = useState(false);
  const [tailRunning, setTailRunning] = useState(false);
  const tailTokenRef = useRef<string | null>(null);
  const tailUnlistenRef = useRef<UnlistenFn | null>(null);
  const maxLineNoRef = useRef<number>(0);
  const minLineNoRef = useRef<number>(0);

  // ---- 搜索 ----
  const [searchPattern, setSearchPattern] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  /** 默认反搜：从后往前 */
  const [searchReverse, setSearchReverse] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<LogSearchHit[]>([]);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [activeHitLine, setActiveHitLine] = useState<number | null>(null);
  const [jumpBusy, setJumpBusy] = useState(false);
  /** 每页命中数；持续搜索用 skip 翻页，不再用 head -n */
  const SEARCH_BATCH = 200;
  /** 反搜：已从文件末尾消费的命中数；正搜：已从文件头消费的命中数 */
  const [searchSkip, setSearchSkip] = useState(0);
  const [searchExhausted, setSearchExhausted] = useState(false);
  const jumpToLineRef = useRef<(lineNo: number) => void>(() => {});

  // ---- 跳转 ----
  const [jumpInput, setJumpInput] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);

  const applyLines = useCallback(
    (lines: { lineNo?: number | null; text: string }[]) => {
      for (const l of lines) {
        const lineNo = l.lineNo ?? 0;
        if (lineNo <= 0) continue;
        linesRef.current.set(lineNo, l.text);
        if (lineNo > maxLineNoRef.current) maxLineNoRef.current = lineNo;
        if (minLineNoRef.current === 0 || lineNo < minLineNoRef.current) {
          minLineNoRef.current = lineNo;
        }
      }
    },
    [],
  );

  // ---------- chunk 拉取（全文件虚拟滚动模式） ----------
  const ensureChunk = useCallback(
    async (chunkStart: number) => {
      if (chunkStart < 1) return;
      const chunkKey = String(chunkStart);
      if (loadedChunksRef.current.has(chunkKey) || inflightChunksRef.current.has(chunkKey)) {
        return;
      }
      inflightChunksRef.current.add(chunkKey);
      const chunkEnd = chunkStart + CHUNK_SIZE - 1;
      try {
        const lines = await readLogLines(sshId, path, chunkStart, chunkEnd);
        if (lines.length === 0) {
          loadedChunksRef.current.add(chunkKey);
          chunkLruRef.current.push(chunkKey);
          return;
        }
        applyLines(lines);
        loadedChunksRef.current.add(chunkKey);
        chunkLruRef.current.push(chunkKey);
        while (chunkLruRef.current.length > MAX_LOADED_CHUNKS) {
          const oldKey = chunkLruRef.current.shift()!;
          if (oldKey === chunkKey) continue;
          loadedChunksRef.current.delete(oldKey);
          const oldStart = parseInt(oldKey, 10);
          for (let i = 0; i < CHUNK_SIZE; i++) {
            linesRef.current.delete(oldStart + i);
          }
        }
        bump();
      } catch (e) {
        setError(fmtError(e));
      } finally {
        inflightChunksRef.current.delete(chunkKey);
      }
    },
    [sshId, path, bump, applyLines],
  );

  const loadTailWindow = useCallback(
    async (n: number, totalHint: number | null) => {
      const lines = await readLogTailInitial(sshId, path, n, totalHint);
      linesRef.current.clear();
      loadedChunksRef.current.clear();
      chunkLruRef.current = [];
      minLineNoRef.current = 0;
      maxLineNoRef.current = 0;
      if (lines.length > 0) {
        applyLines(lines);
        const first = lines[0]!.lineNo ?? 0;
        const last = lines[lines.length - 1]!.lineNo ?? 0;
        const chunkStart = Math.floor((first - 1) / CHUNK_SIZE) * CHUNK_SIZE + 1;
        loadedChunksRef.current.add(String(chunkStart));
        chunkLruRef.current.push(String(chunkStart));
        const lastChunkStart = Math.floor((last - 1) / CHUNK_SIZE) * CHUNK_SIZE + 1;
        if (lastChunkStart !== chunkStart) {
          loadedChunksRef.current.add(String(lastChunkStart));
          chunkLruRef.current.push(String(lastChunkStart));
        }
      }
      return lines.length;
    },
    [sshId, path, applyLines],
  );

  // ---------- 打开会话 ----------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    linesRef.current.clear();
    loadedChunksRef.current.clear();
    chunkLruRef.current = [];
    inflightChunksRef.current.clear();
    maxLineNoRef.current = 0;
    minLineNoRef.current = 0;
    setTotalLines(0);
    setSessionInfo(null);
    setWindowMode(false);
    setWindowSize(WINDOW_INITIAL);

    void (async () => {
      try {
        const info = await openLogSession(sshId, path);
        if (cancelled) return;
        setSessionInfo(info);
        const useWindow = shouldUseWindowMode(info);
        setWindowMode(useWindow);
        const est = info.totalLines ?? 0;
        // totalLines 仅用于状态栏展示；虚拟列表 count 绝不能用估算总行数撑开
        // （否则 4 亿行 * 20px 会在 concurrent render 里炸掉）
        setTotalLines(est);
        if (!useWindow && est > 0) {
          maxLineNoRef.current = est;
        }

        if (useWindow) {
          const n = WINDOW_INITIAL;
          setWindowSize(n);
          try {
            await loadTailWindow(n, info.totalLines ?? null);
            if (cancelled) return;
            if (!info.totalLines) {
              setTotalLines(maxLineNoRef.current);
            } else {
              setTotalLines(Math.max(info.totalLines, maxLineNoRef.current));
            }
            bump();
          } catch (e) {
            if (!cancelled) setError(fmtError(e));
          }
        } else {
          const tailN = Math.min(CHUNK_SIZE, est || CHUNK_SIZE);
          try {
            const lines = await readLogTailInitial(sshId, path, tailN, info.totalLines ?? null);
            if (cancelled) return;
            if (lines.length > 0) {
              applyLines(lines);
              const firstLine = lines[0]!.lineNo ?? 0;
              const lastLine = lines[lines.length - 1]!.lineNo ?? 0;
              const chunkStart = Math.floor((firstLine - 1) / CHUNK_SIZE) * CHUNK_SIZE + 1;
              loadedChunksRef.current.add(String(chunkStart));
              chunkLruRef.current.push(String(chunkStart));
              const lastChunkStart = Math.floor((lastLine - 1) / CHUNK_SIZE) * CHUNK_SIZE + 1;
              if (lastChunkStart !== chunkStart) {
                loadedChunksRef.current.add(String(lastChunkStart));
                chunkLruRef.current.push(String(lastChunkStart));
              }
              if (!info.totalLines) {
                setTotalLines(maxLineNoRef.current);
              }
              bump();
            }
          } catch (e) {
            if (!cancelled) setError(fmtError(e));
          }
        }
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(fmtError(e));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sshId, path, bump, loadTailWindow, applyLines]);

  // ---------- 跟踪停止 cleanup ----------
  useEffect(() => {
    return () => {
      if (tailUnlistenRef.current) {
        tailUnlistenRef.current();
        tailUnlistenRef.current = null;
      }
      const token = tailTokenRef.current;
      if (token) {
        void stopLogTail(token);
        tailTokenRef.current = null;
      }
    };
  }, []);

  // ---------- 虚拟滚动 ----------
  // 窗口模式：只渲染已加载的 [minLineNo, maxLineNo]，绝不用估算总行数撑开虚拟列表
  const loadedMin = minLineNoRef.current;
  const loadedMax = maxLineNoRef.current;
  const viewStartLine =
    windowMode && loadedMin > 0 ? loadedMin : windowMode ? 0 : 1;
  const viewEndLine = windowMode
    ? loadedMax > 0
      ? loadedMax
      : 0
    : Math.max(totalLines, loadedMax, 1);
  // loading 期间 count 必须为 0，避免 setWindowMode 后、tail 返回前出现「1..估算总行数」的天文数字
  const rowCount = loading
    ? 0
    : windowMode
      ? loadedMin > 0 && loadedMax >= loadedMin
        ? Math.min(WINDOW_MAX, loadedMax - loadedMin + 1)
        : 0
      : Math.max(totalLines, loadedMax);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
    useFlushSync: false,
  });
  const virtualItems = rowCount > 0 ? rowVirtualizer.getVirtualItems() : [];

  // 打开后滚到末尾
  useEffect(() => {
    if (loading || rowCount === 0) return;
    rowVirtualizer.scrollToIndex(rowCount - 1, { align: "end" });
    // 仅在首次加载完成时滚一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // 滚动时按需拉取（全文件模式）
  useEffect(() => {
    if (windowMode || virtualItems.length === 0) return;
    const firstIdx = virtualItems[0]!.index;
    const lastIdx = virtualItems[virtualItems.length - 1]!.index;
    const firstChunkStart = Math.floor(firstIdx / CHUNK_SIZE) * CHUNK_SIZE + 1;
    const lastChunkStart = Math.floor(lastIdx / CHUNK_SIZE) * CHUNK_SIZE + 1;
    for (let s = firstChunkStart; s <= lastChunkStart; s += CHUNK_SIZE) {
      void ensureChunk(s);
    }
  }, [virtualItems, ensureChunk, windowMode]);

  // ---------- 跟随滚动 ----------
  useEffect(() => {
    if (!following) return;
    if (rowCount <= 0) return;
    rowVirtualizer.scrollToIndex(rowCount - 1, { align: "end" });
  }, [following, rowCount, rowVirtualizer]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !tailRunning) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 2;
    if (atBottom !== following) {
      setFollowing(atBottom);
    }
  }, [following, tailRunning]);

  // ---------- 窗口模式：加载更多历史 ----------
  const loadMoreHistory = useCallback(async () => {
    if (!windowMode || loadingMore) return;
    const next = Math.min(WINDOW_MAX, windowSize + WINDOW_LOAD_MORE);
    if (next <= windowSize) return;
    setLoadingMore(true);
    setError(null);
    try {
      const hint = sessionInfo?.totalLines ?? (totalLines > 0 ? totalLines : null);
      await loadTailWindow(next, hint);
      setWindowSize(next);
      setTotalLines((prev) => Math.max(prev, maxLineNoRef.current, sessionInfo?.totalLines ?? 0));
      bump();
    } catch (e) {
      setError(fmtError(e));
    } finally {
      setLoadingMore(false);
    }
  }, [
    windowMode,
    loadingMore,
    windowSize,
    sessionInfo,
    totalLines,
    loadTailWindow,
    bump,
  ]);

  // ---------- 跟踪开关 ----------
  const toggleTail = useCallback(async () => {
    if (tailRunning) {
      const token = tailTokenRef.current;
      if (token) {
        try {
          await stopLogTail(token);
        } catch {
          // 忽略停止失败
        }
        tailTokenRef.current = null;
      }
      if (tailUnlistenRef.current) {
        tailUnlistenRef.current();
        tailUnlistenRef.current = null;
      }
      setTailRunning(false);
      setFollowing(false);
      return;
    }
    try {
      const { handle, unsubscribe } = await startLogTail(
        sshId,
        path,
        TAIL_INITIAL_LINES,
        (chunk) => {
          if (chunk.lines.length > 0) {
            const startLine = maxLineNoRef.current + 1;
            chunk.lines.forEach((text: string, i: number) => {
              const lineNo = startLine + i;
              linesRef.current.set(lineNo, text);
              if (lineNo > maxLineNoRef.current) maxLineNoRef.current = lineNo;
              if (minLineNoRef.current === 0 || lineNo < minLineNoRef.current) {
                minLineNoRef.current = lineNo;
              }
            });
            // 窗口模式：跟踪时控制内存上限
            if (windowMode && linesRef.current.size > WINDOW_MAX) {
              const overflow = linesRef.current.size - WINDOW_MAX;
              let removed = 0;
              const keys = [...linesRef.current.keys()].sort((a, b) => a - b);
              for (const k of keys) {
                if (removed >= overflow) break;
                linesRef.current.delete(k);
                removed += 1;
              }
              const remain = linesRef.current.keys();
              let nextMin = 0;
              for (const k of remain) {
                if (nextMin === 0 || k < nextMin) nextMin = k;
              }
              minLineNoRef.current = nextMin;
            }
            setTotalLines((prev) => Math.max(prev, maxLineNoRef.current));
            bump();
          }
          if (chunk.error) {
            setError(chunk.error);
            setTailRunning(false);
          }
          if (chunk.exitCode != null) {
            setTailRunning(false);
          }
        },
      );
      tailTokenRef.current = handle.token;
      tailUnlistenRef.current = unsubscribe;
      setTailRunning(true);
      setFollowing(true);
    } catch (e) {
      setError(fmtError(e));
      setTailRunning(false);
    }
  }, [sshId, path, tailRunning, bump, windowMode]);

  // ---------- 搜索 ----------
  /** 结果面板按行号正序（文件从头到尾） */
  const sortHitsAsc = useCallback((hits: LogSearchHit[]) => {
    const sorted = [...hits];
    sorted.sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0));
    const seen = new Set<number>();
    return sorted.filter((h) => {
      const n = h.lineNo ?? -1;
      if (n < 0 || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  }, []);

  const activeHitElRef = useRef<HTMLButtonElement | null>(null);

  /** 结果列表：当前命中滚入可视区 */
  useEffect(() => {
    if (!searchPanelOpen || activeHitLine == null) return;
    const id = requestAnimationFrame(() => {
      activeHitElRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [activeHitLine, searchPanelOpen, searchResults.length]);

  /** 主视口：命中行已在缓存中时滚到中央（配合 jump 加载完成后的 rowCount 更新） */
  useEffect(() => {
    if (activeHitLine == null || rowCount <= 0) return;
    if (!linesRef.current.has(activeHitLine)) return;
    const idx = windowMode ? activeHitLine - viewStartLine : activeHitLine - 1;
    if (idx < 0 || idx >= rowCount) return;
    rowVirtualizer.scrollToIndex(idx, { align: "center" });
  }, [activeHitLine, rowCount, viewStartLine, windowMode, rowVirtualizer]);

  const runSearch = useCallback(
    async (mode: "fresh" | "continueUp" | "continueDown" = "fresh") => {
      const pattern = searchPattern.trim();
      if (!pattern) {
        setSearchResults([]);
        setSearchPanelOpen(false);
        setActiveHitLine(null);
        setSearchSkip(0);
        setSearchExhausted(false);
        return;
      }
      setSearching(true);
      setError(null);
      try {
        const reverse =
          mode === "continueUp" ? true : mode === "continueDown" ? false : searchReverse;

        // 持续翻页：skip = 已从该方向消费的命中数（tac/grep -m skip+max，不再 head 大行号）
        const skipMatches = mode === "fresh" ? 0 : searchSkip;

        const hits = await searchLog(sshId, path, pattern, {
          isRegex,
          maxResults: SEARCH_BATCH,
          reverse,
          skipMatches,
          totalLinesHint: totalLines > 0 ? totalLines : (sessionInfo?.totalLines ?? null),
        });

        if (mode === "fresh") {
          const sorted = sortHitsAsc(hits);
          setSearchResults(sorted);
          setSearchSkip(sorted.length);
          setSearchExhausted(sorted.length < SEARCH_BATCH);
          setSearchPanelOpen(true);
          if (sorted.length > 0) {
            // 反搜：定位到本批最靠后的命中；正搜：定位到第一条
            const focus = reverse ? sorted[sorted.length - 1]! : sorted[0]!;
            setActiveHitLine(focus.lineNo);
            jumpToLineRef.current(focus.lineNo ?? 0);
          } else {
            setActiveHitLine(null);
            setError("无匹配结果");
          }
          return;
        }

        if (hits.length === 0) {
          setSearchExhausted(true);
          setError(mode === "continueUp" ? "上面没有更多匹配" : "下面没有更多匹配");
          return;
        }

        const merged = sortHitsAsc([...hits, ...searchResults]);
        setSearchResults(merged);
        setSearchSkip((prev) => prev + hits.length);
        setSearchExhausted(hits.length < SEARCH_BATCH);
        setSearchPanelOpen(true);
        // 续搜：跳到本批中最靠近原位置的那条
        const batchAsc = sortHitsAsc(hits);
        const next =
          mode === "continueDown" ? batchAsc[0]! : batchAsc[batchAsc.length - 1]!;
        setActiveHitLine(next.lineNo);
        jumpToLineRef.current(next.lineNo ?? 0);
      } catch (e) {
        setError(fmtError(e));
      } finally {
        setSearching(false);
      }
    },
    [
      searchPattern,
      searchReverse,
      isRegex,
      sshId,
      path,
      totalLines,
      sessionInfo,
      searchSkip,
      searchResults,
      sortHitsAsc,
    ],
  );

  /** 向上：先在已有结果里找更早命中，没有再 skip 翻页 */
  const goSearchUp = useCallback(async () => {
    if (!searchPattern.trim()) return;
    if (searchResults.length > 0 && activeHitLine != null) {
      const older = searchResults
        .filter((h) => h.lineNo < activeHitLine)
        .sort((a, b) => b.lineNo - a.lineNo);
      if (older.length > 0) {
        const next = older[0]!;
        setActiveHitLine(next.lineNo);
        jumpToLineRef.current(next.lineNo);
        return;
      }
    }
    if (searchExhausted && searchResults.length > 0) {
      setError("上面没有更多匹配");
      return;
    }
    await runSearch(searchResults.length === 0 ? "fresh" : "continueUp");
  }, [searchPattern, searchResults, activeHitLine, searchExhausted, runSearch]);

  /** 向下：先在已有结果里找更新命中，没有再翻页 */
  const goSearchDown = useCallback(async () => {
    if (!searchPattern.trim()) return;
    if (searchResults.length > 0 && activeHitLine != null) {
      const newer = searchResults
        .filter((h) => h.lineNo > activeHitLine)
        .sort((a, b) => a.lineNo - b.lineNo);
      if (newer.length > 0) {
        const next = newer[0]!;
        setActiveHitLine(next.lineNo);
        jumpToLineRef.current(next.lineNo);
        return;
      }
    }
    if (searchExhausted && searchResults.length > 0 && !searchReverse) {
      setError("下面没有更多匹配");
      return;
    }
    // 反搜默认从末尾开始，向下 = 在已加载结果里往更新方向；若已在最新则提示
    if (searchReverse && searchResults.length > 0) {
      setError("已在最近一处匹配（反搜从末尾开始，请点「向上」看更早记录）");
      return;
    }
    await runSearch(searchResults.length === 0 ? "fresh" : "continueDown");
  }, [searchPattern, searchResults, activeHitLine, searchExhausted, searchReverse, runSearch]);

  // ---------- 跳转 ----------
  const jumpToLine = useCallback(
    async (lineNo: number) => {
      if (lineNo < 1) return;
      setActiveHitLine(lineNo);

      // 已在当前窗口/缓存中
      if (linesRef.current.has(lineNo)) {
        const idx = windowMode ? lineNo - viewStartLine : lineNo - 1;
        if (idx >= 0 && idx < rowCount) {
          rowVirtualizer.scrollToIndex(idx, { align: "center" });
        }
        return;
      }

      if (windowMode) {
        // 超大文件：靠近末尾用 tail（快）；远离末尾禁止 sed 全盘扫（会超时）
        setJumpBusy(true);
        setError(null);
        try {
          const totalHint =
            totalLines > 0 ? totalLines : (sessionInfo?.totalLines ?? null);
          const fromEnd =
            totalHint != null && totalHint >= lineNo ? totalHint - lineNo + 1 : null;
          const half = Math.floor(WINDOW_INITIAL / 2);
          /** 搜索跳转允许比普通窗口更大的 tail 范围 */
          const SEARCH_JUMP_TAIL_MAX = 100_000;

          if (fromEnd != null && fromEnd > 0 && fromEnd <= SEARCH_JUMP_TAIL_MAX) {
            const n = Math.min(
              SEARCH_JUMP_TAIL_MAX,
              Math.max(WINDOW_INITIAL, fromEnd + half),
            );
            await loadTailWindow(n, totalHint);
            setWindowSize(Math.min(WINDOW_MAX, Math.max(windowSize, Math.min(n, WINDOW_MAX))));
            bump();
            const base = minLineNoRef.current || 1;
            const idx = lineNo - base;
            const count = Math.max(0, maxLineNoRef.current - base + 1);
            if (idx >= 0 && count > 0) {
              rowVirtualizer.scrollToIndex(Math.min(idx, count - 1), { align: "center" });
            }
          } else if (fromEnd != null && fromEnd > SEARCH_JUMP_TAIL_MAX) {
            setError(
              `该命中距末尾约 ${fromEnd.toLocaleString()} 行，超出快速定位范围；请在右侧结果列表查看内容，或继续点「↑ 向上」浏览更早命中`,
            );
          } else {
            // 无总行数：小范围 sed，失败则提示
            const start = Math.max(1, lineNo - half);
            const end = start + WINDOW_INITIAL - 1;
            const lines = await readLogLines(sshId, path, start, end);
            linesRef.current.clear();
            loadedChunksRef.current.clear();
            chunkLruRef.current = [];
            minLineNoRef.current = 0;
            maxLineNoRef.current = 0;
            applyLines(lines);
            setWindowSize(Math.min(WINDOW_MAX, Math.max(windowSize, lines.length)));
            bump();
            const base = minLineNoRef.current || start;
            const idx = lineNo - base;
            if (idx >= 0) {
              rowVirtualizer.scrollToIndex(idx, { align: "center" });
            }
          }
        } catch (e) {
          setError(
            `${fmtError(e)}（大文件请用搜索结果列表查看，避免跨段 sed 读取）`,
          );
        } finally {
          setJumpBusy(false);
        }
        return;
      }

      if (lineNo > rowCount) return;
      const chunkStart = Math.floor((lineNo - 1) / CHUNK_SIZE) * CHUNK_SIZE + 1;
      void ensureChunk(chunkStart).then(() => {
        rowVirtualizer.scrollToIndex(lineNo - 1, { align: "center" });
      });
    },
    [
      windowMode,
      windowSize,
      viewStartLine,
      rowCount,
      rowVirtualizer,
      sshId,
      path,
      applyLines,
      bump,
      ensureChunk,
      totalLines,
      sessionInfo,
      loadTailWindow,
    ],
  );
  jumpToLineRef.current = (lineNo) => {
    void jumpToLine(lineNo);
  };

  const handleJumpSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const n = parseInt(jumpInput.trim(), 10);
      if (Number.isFinite(n) && n >= 1) {
        void jumpToLine(n);
        setJumpInput("");
      }
    },
    [jumpInput, jumpToLine],
  );

  // ---------- 渲染 ----------
  const paddingTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end
      : 0;

  const lineNoWidth = useMemo(() => {
    const digits = String(Math.max(viewEndLine, totalLines, 1)).length;
    return Math.max(48, digits * 8 + 16);
  }, [viewEndLine, totalLines]);

  const metaLinesLabel = (() => {
    if (!sessionInfo) return "";
    if (windowMode) {
      const shown = Math.max(0, viewEndLine - viewStartLine + 1);
      const total = totalLines > 0 ? totalLines.toLocaleString() : "?";
      const approx = sessionInfo.linesEstimated ? "≈ " : "";
      return `显示末尾 ${shown.toLocaleString()} 行 · ${approx}${total} 行`;
    }
    return `${rowCount.toLocaleString()} 行`;
  })();

  if (loading) {
    return (
      <div className={`log-viewer log-viewer--loading${className ? ` ${className}` : ""}`}>
        <div className="log-viewer__status">{t("files.preview.loading")}</div>
      </div>
    );
  }

  if (error && rowCount === 0) {
    return (
      <div className={`log-viewer log-viewer--error${className ? ` ${className}` : ""}`}>
        <div className="log-viewer__status log-viewer__status--error">{error}</div>
      </div>
    );
  }

  return (
    <div className={`log-viewer${className ? ` ${className}` : ""}`}>
      <div className="log-viewer__toolbar">
        <button
          type="button"
          className={`log-viewer__btn${tailRunning ? " active" : ""}`}
          onClick={() => void toggleTail()}
          title={tailRunning ? "停止跟踪" : "开始跟踪"}
        >
          {tailRunning ? "■ 停止跟踪" : "▶ 跟踪"}
        </button>
        {tailRunning && (
          <button
            type="button"
            className={`log-viewer__btn${following ? " active" : ""}`}
            onClick={() => setFollowing((v) => !v)}
            title={following ? "暂停跟随" : "回到最新"}
          >
            {following ? "⏸ 暂停跟随" : "↓ 回到最新"}
          </button>
        )}

        {windowMode && (
          <button
            type="button"
            className="log-viewer__btn"
            disabled={loadingMore || windowSize >= WINDOW_MAX}
            onClick={() => void loadMoreHistory()}
            title="向上加载更多历史行（tail）"
          >
            {loadingMore
              ? "加载中..."
              : windowSize >= WINDOW_MAX
                ? "已达上限"
                : "↑ 加载更多历史"}
          </button>
        )}

        <form
          className="log-viewer__search"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch("fresh");
          }}
        >
          <input
            type="text"
            value={searchPattern}
            onChange={(e) => setSearchPattern(e.target.value)}
            placeholder={searchReverse ? "反搜（从后往前）..." : "正搜（从前往后）..."}
            className="log-viewer__input"
          />
          <button
            type="button"
            className={`log-viewer__btn log-viewer__btn--toggle${searchReverse ? " active" : ""}`}
            onClick={() => {
              setSearchReverse(true);
              setSearchSkip(0);
              setSearchExhausted(false);
            }}
            title="反搜：从文件末尾往前找（默认，适合大日志）"
          >
            反搜
          </button>
          <button
            type="button"
            className={`log-viewer__btn log-viewer__btn--toggle${!searchReverse ? " active" : ""}`}
            onClick={() => {
              setSearchReverse(false);
              setSearchSkip(0);
              setSearchExhausted(false);
            }}
            title="正搜：从文件开头往后找"
          >
            正搜
          </button>
          <button
            type="button"
            className={`log-viewer__btn log-viewer__btn--toggle${isRegex ? " active" : ""}`}
            onClick={() => setIsRegex((v) => !v)}
            title={isRegex ? "正则模式（点击切换为普通文本）" : "普通文本（点击切换为正则）"}
          >
            .*
          </button>
          <button type="submit" className="log-viewer__btn" disabled={searching}>
            {searching ? "搜索中..." : "搜索"}
          </button>
          <button
            type="button"
            className="log-viewer__btn"
            disabled={searching || !searchPattern.trim()}
            onClick={() => void goSearchUp()}
            title="向上找更早的匹配；当前页翻完后自动加载下一页"
          >
            {searching ? "…" : "↑ 向上"}
          </button>
          <button
            type="button"
            className="log-viewer__btn"
            disabled={searching || !searchPattern.trim()}
            onClick={() => void goSearchDown()}
            title="向下找更新的匹配"
          >
            ↓ 向下
          </button>
          {searchResults.length > 0 && (
            <button
              type="button"
              className="log-viewer__btn"
              onClick={() => setSearchPanelOpen((v) => !v)}
            >
              {searchPanelOpen
                ? "隐藏结果"
                : `结果 ${searchResults.length}${searchExhausted ? "" : "+"}`}
            </button>
          )}
        </form>

        <form className="log-viewer__jump" onSubmit={handleJumpSubmit}>
          <input
            type="text"
            inputMode="numeric"
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value)}
            placeholder="跳转行号"
            className="log-viewer__input log-viewer__input--narrow"
            disabled={jumpBusy}
          />
          <button type="submit" className="log-viewer__btn" disabled={jumpBusy}>
            {jumpBusy ? "跳转中..." : "跳转"}
          </button>
        </form>

        <div className="log-viewer__meta">
          {sessionInfo && (
            <>
              <span title="文件大小">{formatFileSize(sessionInfo.sizeBytes)}</span>
              <span title="行数信息">{metaLinesLabel}</span>
              {sessionInfo.linesEstimated && (
                <span title="总行数由采样估算">估算</span>
              )}
              {tailRunning && <span className="log-viewer__live">● LIVE</span>}
            </>
          )}
        </div>
      </div>

      {error && rowCount > 0 && (
        <div className="log-viewer__banner log-viewer__banner--error">{error}</div>
      )}

      <div className="log-viewer__body">
        <div className="log-viewer__viewport" ref={scrollRef} onScroll={handleScroll}>
          {paddingTop > 0 && <div style={{ height: paddingTop }} />}
          {virtualItems.map((item) => {
            const lineNo = windowMode ? viewStartLine + item.index : item.index + 1;
            const text = linesRef.current.get(lineNo);
            const isActiveHit = activeHitLine === lineNo;
            return (
              <div
                key={item.key}
                className={`log-viewer__row${isActiveHit ? " active-hit" : ""}`}
                style={{ height: ROW_HEIGHT }}
              >
                <span
                  className="log-viewer__lineno"
                  style={{ width: lineNoWidth, minWidth: lineNoWidth }}
                >
                  {lineNo}
                </span>
                <span className="log-viewer__text">
                  {text ?? <span className="log-viewer__placeholder">···</span>}
                </span>
              </div>
            );
          })}
          {paddingBottom > 0 && <div style={{ height: paddingBottom }} />}
        </div>

        {searchPanelOpen && (
          <div className="log-viewer__search-panel">
            <div className="log-viewer__search-header">
              <span>
                命中 {searchResults.length} 条（正序）
                {searchExhausted ? "" : " · 可继续↑"}
              </span>
              <button
                type="button"
                className="log-viewer__btn log-viewer__btn--icon"
                onClick={() => setSearchPanelOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="log-viewer__search-list">
              {searchResults.map((hit) => {
                const isActive = activeHitLine === hit.lineNo;
                return (
                  <button
                    key={hit.lineNo}
                    type="button"
                    data-hit-line={hit.lineNo ?? undefined}
                    ref={(el) => {
                      if (isActive) activeHitElRef.current = el;
                    }}
                    className={`log-viewer__hit${isActive ? " active" : ""}`}
                    onClick={() => void jumpToLine(hit.lineNo ?? 0)}
                  >
                    <span className="log-viewer__hit-line">L{hit.lineNo}</span>
                    <span className="log-viewer__hit-content">{hit.content}</span>
                  </button>
                );
              })}
              {searchResults.length === 0 && (
                <div className="log-viewer__empty">无命中</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
