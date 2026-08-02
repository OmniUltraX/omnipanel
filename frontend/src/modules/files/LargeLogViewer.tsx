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

interface LargeLogViewerProps {
  /** SSH 资源 id（交互式会话或连接池资源 id） */
  sshId: string;
  /** 远端文件绝对路径 */
  path: string;
  className?: string;
}

/**
 * 大日志文件流式预览器（>10MB）。
 *
 * - 打开时探测 size + wc -l 总行数
 * - 虚拟滚动按需拉取 sed -n 'X,Yp' 切片，chunk LRU cache
 * - 跟踪开关：tail -F，新行追加到底部；用户上滚暂停跟随，点"回到最新"恢复
 * - 搜索：grep -n，结果侧栏点击跳转
 */
export function LargeLogViewer({ sshId, path, className }: LargeLogViewerProps) {
  const { t } = useI18n();

  // ---- 行数据：用 Map<lineNo, text> 支持稀疏加载 ----
  const linesRef = useRef<Map<number, string>>(new Map());
  const loadedChunksRef = useRef<Set<string>>(new Set());
  const chunkLruRef = useRef<string[]>([]); // chunk key 按访问顺序，淘汰用
  const inflightChunksRef = useRef<Set<string>>(new Set()); // 防止重复拉取

  // ---- 会话与状态 ----
  const [sessionInfo, setSessionInfo] = useState<LogSessionInfo | null>(null);
  const [totalLines, setTotalLines] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, forceRender] = useState(0); // 行数据更新后强制重渲染
  const bump = useCallback(() => forceRender((v) => v + 1), []);

  // ---- 跟踪 ----
  const [following, setFollowing] = useState(false);
  const [tailRunning, setTailRunning] = useState(false);
  const tailTokenRef = useRef<string | null>(null);
  const tailUnlistenRef = useRef<UnlistenFn | null>(null);
  const maxLineNoRef = useRef<number>(0); // 当前已知最大行号（含跟踪追加）

  // ---- 搜索 ----
  const [searchPattern, setSearchPattern] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<LogSearchHit[]>([]);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [activeHitLine, setActiveHitLine] = useState<number | null>(null);

  // ---- 跳转 ----
  const [jumpInput, setJumpInput] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);

  // ---------- chunk 拉取 ----------
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
          // 空响应：标记已加载避免反复请求
          loadedChunksRef.current.add(chunkKey);
          chunkLruRef.current.push(chunkKey);
          return;
        }
        for (const l of lines) {
          const lineNo = l.lineNo ?? 0;
          if (lineNo <= 0) continue;
          linesRef.current.set(lineNo, l.text);
          if (lineNo > maxLineNoRef.current) maxLineNoRef.current = lineNo;
        }
        loadedChunksRef.current.add(chunkKey);
        chunkLruRef.current.push(chunkKey);
        // LRU 淘汰
        while (chunkLruRef.current.length > MAX_LOADED_CHUNKS) {
          const oldKey = chunkLruRef.current.shift()!;
          if (oldKey === chunkKey) continue; // 不淘汰刚加入的
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
    [sshId, path, bump],
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
    setTotalLines(0);
    setSessionInfo(null);

    void (async () => {
      try {
        const info = await openLogSession(sshId, path);
        if (cancelled) return;
        setSessionInfo(info);
        const est = info.totalLines ?? 0;
        setTotalLines(est);
        maxLineNoRef.current = est;
        // 默认滚到末尾：用 tail -n N 直接读末尾（12ms vs sed 370ms @ 1GB）
        // 不走 ensureChunk（sed -n 'X,Yp' 会扫描到 Y 行）
        const tailN = Math.min(CHUNK_SIZE, est || CHUNK_SIZE);
        try {
          const lines = await readLogTailInitial(sshId, path, tailN, info.totalLines ?? null);
          if (cancelled) return;
          if (lines.length > 0) {
            // 标记末尾 chunk 已加载，避免虚拟滚动重复触发 ensureChunk
            const firstLine = lines[0]!.lineNo ?? 0;
            const lastLine = lines[lines.length - 1]!.lineNo ?? 0;
            const chunkStart = Math.floor((firstLine - 1) / CHUNK_SIZE) * CHUNK_SIZE + 1;
            for (const l of lines) {
              const lineNo = l.lineNo ?? 0;
              if (lineNo <= 0) continue;
              linesRef.current.set(lineNo, l.text);
              if (lineNo > maxLineNoRef.current) maxLineNoRef.current = lineNo;
            }
            loadedChunksRef.current.add(String(chunkStart));
            chunkLruRef.current.push(String(chunkStart));
            // 如果末尾行跨了两个 chunk，也标记第二个
            const lastChunkStart = Math.floor((lastLine - 1) / CHUNK_SIZE) * CHUNK_SIZE + 1;
            if (lastChunkStart !== chunkStart) {
              loadedChunksRef.current.add(String(lastChunkStart));
              chunkLruRef.current.push(String(lastChunkStart));
            }
            // 如果 totalLines 为 null（wc -l 超时/失败），用 tail 返回的行号推算
            if (!info.totalLines) {
              setTotalLines(maxLineNoRef.current);
            }
            bump();
          }
        } catch (e) {
          if (!cancelled) setError(fmtError(e));
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
  }, [sshId, path, bump]);

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
  const rowCount = Math.max(totalLines, maxLineNoRef.current);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
    useFlushSync: false,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  // 滚动时按需拉取可见行所在 chunk
  useEffect(() => {
    if (virtualItems.length === 0) return;
    const firstIdx = virtualItems[0]!.index;
    const lastIdx = virtualItems[virtualItems.length - 1]!.index;
    const firstChunkStart = Math.floor(firstIdx / CHUNK_SIZE) * CHUNK_SIZE + 1;
    const lastChunkStart = Math.floor(lastIdx / CHUNK_SIZE) * CHUNK_SIZE + 1;
    for (let s = firstChunkStart; s <= lastChunkStart; s += CHUNK_SIZE) {
      void ensureChunk(s);
    }
  }, [virtualItems, ensureChunk]);

  // ---------- 跟随滚动 ----------
  const followRef = useRef(following);
  followRef.current = following;
  useEffect(() => {
    if (!following) return;
    const el = scrollRef.current;
    if (!el) return;
    // 滚到底部
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

  // ---------- 跟踪开关 ----------
  const toggleTail = useCallback(async () => {
    if (tailRunning) {
      // 停止
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
    // 启动
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
            });
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
  }, [sshId, path, tailRunning, bump]);

  // ---------- 搜索 ----------
  const runSearch = useCallback(async () => {
    const pattern = searchPattern.trim();
    if (!pattern) {
      setSearchResults([]);
      setSearchPanelOpen(false);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const hits = await searchLog(sshId, path, pattern, {
        isRegex,
        maxResults: 2000,
      });
      setSearchResults(hits);
      setSearchPanelOpen(true);
      setActiveHitLine(null);
    } catch (e) {
      setError(fmtError(e));
    } finally {
      setSearching(false);
    }
  }, [sshId, path, searchPattern, isRegex]);

  // ---------- 跳转 ----------
  const jumpToLine = useCallback(
    (lineNo: number) => {
      if (lineNo < 1 || lineNo > rowCount) return;
      const chunkStart = Math.floor((lineNo - 1) / CHUNK_SIZE) * CHUNK_SIZE + 1;
      void ensureChunk(chunkStart).then(() => {
        rowVirtualizer.scrollToIndex(lineNo - 1, { align: "center" });
        setActiveHitLine(lineNo);
      });
    },
    [rowCount, ensureChunk, rowVirtualizer],
  );

  const handleJumpSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const n = parseInt(jumpInput.trim(), 10);
      if (Number.isFinite(n) && n >= 1) {
        jumpToLine(n);
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
    const digits = String(Math.max(rowCount, 1)).length;
    // 等宽字符 ~7px + padding
    return Math.max(48, digits * 8 + 16);
  }, [rowCount]);

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
      {/* 工具栏 */}
      <div className="log-viewer__toolbar">
        <button
          type="button"
          className={`log-viewer__btn${tailRunning ? " active" : ""}`}
          onClick={toggleTail}
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

        <form
          className="log-viewer__search"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch();
          }}
        >
          <input
            type="text"
            value={searchPattern}
            onChange={(e) => setSearchPattern(e.target.value)}
            placeholder="搜索（grep）..."
            className="log-viewer__input"
          />
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
          {searchResults.length > 0 && (
            <button
              type="button"
              className="log-viewer__btn"
              onClick={() => setSearchPanelOpen((v) => !v)}
            >
              {searchPanelOpen ? "隐藏结果" : `结果 ${searchResults.length}`}
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
          />
          <button type="submit" className="log-viewer__btn">
            跳转
          </button>
        </form>

        <div className="log-viewer__meta">
          {sessionInfo && (
            <>
              <span title="文件大小">{formatFileSize(sessionInfo.sizeBytes)}</span>
              <span title="总行数">{rowCount.toLocaleString()} 行</span>
              {tailRunning && <span className="log-viewer__live">● LIVE</span>}
            </>
          )}
        </div>
      </div>

      {error && rowCount > 0 && (
        <div className="log-viewer__banner log-viewer__banner--error">{error}</div>
      )}

      {/* 主体：左侧虚拟滚动 + 右侧搜索结果 */}
      <div className="log-viewer__body">
        <div className="log-viewer__viewport" ref={scrollRef} onScroll={handleScroll}>
          {paddingTop > 0 && <div style={{ height: paddingTop }} />}
          {virtualItems.map((item) => {
            const lineNo = item.index + 1; // 1-based
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
              <span>命中 {searchResults.length} 条</span>
              <button
                type="button"
                className="log-viewer__btn log-viewer__btn--icon"
                onClick={() => setSearchPanelOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="log-viewer__search-list">
              {searchResults.map((hit) => (
                <button
                  key={hit.lineNo}
                  type="button"
                  className={`log-viewer__hit${activeHitLine === hit.lineNo ? " active" : ""}`}
                  onClick={() => jumpToLine(hit.lineNo ?? 0)}
                >
                  <span className="log-viewer__hit-line">L{hit.lineNo}</span>
                  <span className="log-viewer__hit-content">{hit.content}</span>
                </button>
              ))}
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
