import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  EMPTY_TERMINAL_BLOCKS,
  useBlocksStore,
  type TerminalBlock,
  isAiThreadToolCall,
} from "../../stores/blocksStore";
import { extractCommandOutput } from "./terminalOutputText";
import { useTerminalUiStore } from "./terminalUiStore";
import { TerminalAiThreadView } from "./TerminalAiThreadView";
import { getResolvedAiThread } from "./aiThreadBridge";
import { AiDockResizeHandle } from "./AiDockResizeHandle";
import { DEFAULT_AI_DOCK_HEIGHT } from "./terminalAiDock";
import { useStickyAiBlockId } from "./useStickyAiBlockId";
import { useStickyActive } from "./useStickyActive";

type TerminalBlockFeedProps = {
  sessionId: string;
  promptSymbol?: string;
};

function blockTitle(block: TerminalBlock): string {
  if (block.kind === "ai" && block.title?.trim()) return block.title.trim();
  const cmd = block.command.trim();
  if (cmd) return cmd;
  return "命令";
}

function shellOutput(block: TerminalBlock): string {
  const cleaned = extractCommandOutput(block.output, block.command);
  return cleaned || block.output.trim();
}

function cwdLabel(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) return "~";
  if (trimmed === "/") return "/";
  const parts = trimmed.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  const last = parts[parts.length - 1];
  return parts.length > 1 && last ? `…/${last}` : `/${last}`;
}

function formatDuration(block: TerminalBlock): string | null {
  if (!block.completedAt || block.status === "running") return null;
  const ms = block.completedAt - block.timestamp;
  if (ms < 0) return null;
  return `${(ms / 1000).toFixed(2)}s`;
}

function shouldRenderBlock(block: TerminalBlock): boolean {
  if (block.kind === "ai") return true;
  const cmd = block.command.trim();
  if (!cmd) return false;
  const out = shellOutput(block);
  if (block.status === "running") {
    return true;
  }
  return out.length > 0 || block.status === "failed";
}

/** 用于检测 Feed 内容变化（新块、输出增长、AI 流式等） */
function buildFeedActivitySignature(blocks: TerminalBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "ai") {
        const thread = getResolvedAiThread(block);
        const threadSig = thread
          .map((item) => {
            if (item.kind === "message") {
              return `m:${item.id}:${item.content.length}:${item.reasoning?.length ?? 0}`;
            }
            return `t:${item.id}:${item.status}:${item.command?.length ?? 0}:${item.result?.length ?? 0}`;
          })
          .join("|");
        return `ai:${block.id}:${block.status}:${threadSig}`;
      }
      return `sh:${block.id}:${block.status}:${shellOutput(block).length}`;
    })
    .join(";");
}

function scrollFeedToLatest(container: HTMLElement) {
  container.scrollTop = container.scrollHeight;
  container
    .querySelectorAll<HTMLElement>(
      ".term-warp-ai-sticky-host--active .term-warp-ai-thread",
    )
    .forEach((thread) => {
      thread.scrollTop = thread.scrollHeight;
    });
}

const FEED_SCROLL_PIN_THRESHOLD_PX = 80;

function isFeedPinnedToBottom(container: HTMLElement): boolean {
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
  return distance <= FEED_SCROLL_PIN_THRESHOLD_PX;
}

function scrollFeedToLatestIfPinned(container: HTMLElement) {
  if (!isFeedPinnedToBottom(container)) return;
  scrollFeedToLatest(container);
}

function AiStatusIcon({ block }: { block: TerminalBlock }) {
  if (block.status === "running") {
    return <span className="term-warp-block__status term-warp-block__status--running" aria-hidden />;
  }
  if (block.status === "failed" || (block.exitCode !== null && block.exitCode !== 0)) {
    return <span className="term-warp-block__status term-warp-block__status--failed">✕</span>;
  }
  return <span className="term-warp-block__status term-warp-block__status--ok">✓</span>;
}

function AiBlockCard({
  block,
  sessionId,
  expanded,
  onToggle,
  isStickyCandidate,
  feedScrollRef,
  feedPinnedToBottom,
}: {
  block: TerminalBlock;
  sessionId: string;
  expanded: boolean;
  onToggle: () => void;
  /** 当前视口上下文中可吸顶的 AI 候选 */
  isStickyCandidate?: boolean;
  feedScrollRef: RefObject<HTMLElement | null>;
  feedPinnedToBottom: boolean;
}) {
  const [sentinelEl, setSentinelEl] = useState<HTMLDivElement | null>(null);
  const isStickyActive = useStickyActive(
    sentinelEl,
    feedScrollRef,
    Boolean(isStickyCandidate),
  );
  const dockMaxHeight = useTerminalUiStore(
    (state) => state.aiDockHeights[sessionId] ?? DEFAULT_AI_DOCK_HEIGHT,
  );

  if (!isStickyCandidate) {
    if (!expanded) {
      return (
        <article
          className="term-warp-block term-warp-block--ai term-warp-block--collapsed"
          data-block-id={block.id}
        >
          <button type="button" className="term-warp-block__summary" onClick={onToggle}>
            <span className="term-warp-ai-mark" aria-hidden>
              AI
            </span>
            <AiStatusIcon block={block} />
            <span className="term-warp-block__title">{blockTitle(block)}</span>
            <span className="term-warp-block__chevron" aria-hidden>
              ›
            </span>
          </button>
        </article>
      );
    }

    return (
      <article
        className="term-warp-block term-warp-block--ai term-warp-block--expanded"
        data-block-id={block.id}
      >
        <header className="term-warp-block__header">
          <button
            type="button"
            className="term-warp-block__summary term-warp-block__summary--open"
            onClick={onToggle}
          >
            <span className="term-warp-ai-mark" aria-hidden>
              AI
            </span>
            <AiStatusIcon block={block} />
            <span className="term-warp-block__title">{blockTitle(block)}</span>
            <span className="term-warp-block__chevron term-warp-block__chevron--open" aria-hidden>
              ›
            </span>
          </button>
          <span className="term-warp-block__badge">助手</span>
        </header>
        <TerminalAiThreadView blockId={block.id} />
      </article>
    );
  }

  const stickySentinel = (
    <div
      ref={setSentinelEl}
      className="term-warp-ai-sticky-sentinel"
      aria-hidden
    />
  );

  const stickyCollapsedClass = " term-warp-block--ai-sticky";

  if (!expanded) {
    return (
      <>
        {stickySentinel}
        <article
          className={`term-warp-block term-warp-block--ai term-warp-block--collapsed${stickyCollapsedClass}`}
          data-block-id={block.id}
        >
          <button type="button" className="term-warp-block__summary" onClick={onToggle}>
            <span className="term-warp-ai-mark" aria-hidden>
              AI
            </span>
            <AiStatusIcon block={block} />
            <span className="term-warp-block__title">{blockTitle(block)}</span>
            <span className="term-warp-block__chevron" aria-hidden>
              ›
            </span>
          </button>
        </article>
      </>
    );
  }

  const article = (
    <article
      className={`term-warp-block term-warp-block--ai term-warp-block--expanded${
        isStickyActive ? " term-warp-block--ai-sticky-docked" : ""
      }`}
    >
      <header className="term-warp-block__header">
        <button
          type="button"
          className="term-warp-block__summary term-warp-block__summary--open"
          onClick={onToggle}
        >
          <span className="term-warp-ai-mark" aria-hidden>
            AI
          </span>
          <AiStatusIcon block={block} />
          <span className="term-warp-block__title">{blockTitle(block)}</span>
          <span className="term-warp-block__chevron term-warp-block__chevron--open" aria-hidden>
            ›
          </span>
        </button>
        <span className="term-warp-block__badge">助手</span>
      </header>
      <TerminalAiThreadView
        blockId={block.id}
        dockedAutoScroll={isStickyActive && feedPinnedToBottom}
      />
    </article>
  );

  return (
    <>
      {stickySentinel}
      <div
        className={`term-warp-ai-sticky-host${
          isStickyActive ? " term-warp-ai-sticky-host--active" : ""
        }`}
        style={isStickyActive ? { maxHeight: dockMaxHeight } : undefined}
        data-block-id={block.id}
      >
        {article}
        {isStickyActive ? <AiDockResizeHandle sessionId={sessionId} /> : null}
      </div>
    </>
  );
}

function ShellBlockCard({
  block,
  promptSymbol = "$",
}: {
  block: TerminalBlock;
  promptSymbol?: string;
}) {
  const output = shellOutput(block);
  const duration = formatDuration(block);
  const running = block.status === "running";
  const cmd = block.command.trim();
  const isError =
    block.status === "failed" || (block.exitCode !== null && block.exitCode !== 0);

  return (
    <article className="term-warp-block term-warp-block--shell" data-block-id={block.id}>
      <div className="term-warp-prompt-line">
        <span className="term-warp-prompt-line__path">{cwdLabel(block.cwd)}</span>
        <span className="term-warp-prompt-line__symbol">{promptSymbol}</span>
        <span className="term-warp-prompt-line__cmd">{cmd}</span>
        {duration ? <span className="term-warp-prompt-line__dur">{duration}</span> : null}
        {running && !output ? (
          <span className="term-warp-prompt-line__spinner" aria-label="执行中" />
        ) : null}
      </div>
      {output ? (
        <pre
          className={`term-warp-output${isError ? " term-warp-output--error" : ""}`}
        >
          {output}
        </pre>
      ) : null}
    </article>
  );
}

function resolveAiExpanded(
  block: TerminalBlock,
  expandedAiBlockId: string | null,
): boolean {
  const thread = getResolvedAiThread(block);
  const hasActiveTool = thread.some(
    (item) =>
      isAiThreadToolCall(item) &&
      (item.status === "pending" || item.status === "running"),
  );
  return (
    block.status === "running" ||
    hasActiveTool ||
    expandedAiBlockId === block.id
  );
}

function WarpBlockCard({
  block,
  sessionId,
  promptSymbol,
  expandedAiBlockId,
  setExpandedAiBlock,
  stickyAiBlockId,
  feedScrollRef,
  feedPinnedToBottom,
}: {
  block: TerminalBlock;
  sessionId: string;
  promptSymbol?: string;
  expandedAiBlockId: string | null;
  setExpandedAiBlock: (sessionId: string, blockId: string | null) => void;
  stickyAiBlockId: string | null;
  feedScrollRef: RefObject<HTMLElement | null>;
  feedPinnedToBottom: boolean;
}) {
  const isAi = block.kind === "ai";
  const thread = isAi ? getResolvedAiThread(block) : [];
  const hasActiveTool = thread.some(
    (item) =>
      isAiThreadToolCall(item) &&
      (item.status === "pending" || item.status === "running"),
  );
  const expanded = isAi && resolveAiExpanded(block, expandedAiBlockId);
  const isStickyCandidate = isAi && block.id === stickyAiBlockId;

  const onToggle = () => {
    if (!isAi || block.status === "running" || hasActiveTool) return;
    if (expanded) {
      setExpandedAiBlock(sessionId, null);
    } else {
      setExpandedAiBlock(sessionId, block.id);
    }
  };

  if (isAi) {
    return (
      <AiBlockCard
        block={block}
        sessionId={sessionId}
        expanded={expanded}
        onToggle={onToggle}
        isStickyCandidate={isStickyCandidate}
        feedScrollRef={feedScrollRef}
        feedPinnedToBottom={feedPinnedToBottom}
      />
    );
  }

  return <ShellBlockCard block={block} promptSymbol={promptSymbol} />;
}

/** Warp 式 Block 流：shell 与 AI 卡片按时间交错排列 */
export function TerminalBlockFeed({ sessionId, promptSymbol }: TerminalBlockFeedProps) {
  const blocks = useBlocksStore((state) => state.blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS);
  const expandedAiBlockId = useTerminalUiStore((state) => state.expandedAiBlockIds[sessionId] ?? null);
  const setExpandedAiBlock = useTerminalUiStore((state) => state.setExpandedAiBlock);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevBlockCountRef = useRef(0);
  const [feedPinnedToBottom, setFeedPinnedToBottom] = useState(true);

  const visibleBlocks = blocks.filter(shouldRenderBlock);
  const activitySignature = useMemo(
    () => buildFeedActivitySignature(visibleBlocks),
    [visibleBlocks],
  );
  const stickyAiBlockId = useStickyAiBlockId(scrollRef, listRef, visibleBlocks, activitySignature);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const syncPinned = () => {
      setFeedPinnedToBottom(isFeedPinnedToBottom(el));
    };

    syncPinned();
    el.addEventListener("scroll", syncPinned, { passive: true });
    window.addEventListener("resize", syncPinned);
    return () => {
      el.removeEventListener("scroll", syncPinned);
      window.removeEventListener("resize", syncPinned);
    };
  }, [visibleBlocks.length]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const blockCountGrew = visibleBlocks.length > prevBlockCountRef.current;
    prevBlockCountRef.current = visibleBlocks.length;

    if (blockCountGrew || isFeedPinnedToBottom(el)) {
      scrollFeedToLatest(el);
      requestAnimationFrame(() => {
        if (blockCountGrew || isFeedPinnedToBottom(el)) {
          scrollFeedToLatest(el);
        }
      });
    }
  }, [activitySignature, visibleBlocks.length]);

  useEffect(() => {
    const list = listRef.current;
    const container = scrollRef.current;
    if (!list || !container) return;

    const observer = new ResizeObserver(() => {
      scrollFeedToLatestIfPinned(container);
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [visibleBlocks.length]);

  if (visibleBlocks.length === 0) return null;

  return (
    <div className="term-warp-feed" ref={scrollRef}>
      <div className="term-warp-feed__list" ref={listRef}>
        {visibleBlocks.map((block) => (
          <WarpBlockCard
            key={block.id}
            block={block}
            sessionId={sessionId}
            promptSymbol={promptSymbol}
            expandedAiBlockId={expandedAiBlockId}
            setExpandedAiBlock={setExpandedAiBlock}
            stickyAiBlockId={stickyAiBlockId}
            feedScrollRef={scrollRef}
            feedPinnedToBottom={feedPinnedToBottom}
          />
        ))}
      </div>
    </div>
  );
}
