import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  EMPTY_TERMINAL_BLOCKS,
  useBlocksStore,
  type TerminalBlock,
  isAiThreadToolCall,
} from "../../stores/blocksStore";
import { extractCommandOutput, isEchoOnlyTerminalOutput, normalizeBlockCommand, stripTerminalControlSequences } from "./terminalOutputText";
import { isResidualShellNoise } from "./terminalCommandEcho";
import { useTerminalUiStore } from "./terminalUiStore";
import { TerminalAiThreadView } from "./TerminalAiThreadView";
import { getResolvedAiThread } from "./aiThreadBridge";
import { AiDockResizeHandle } from "./AiDockResizeHandle";
import { DEFAULT_AI_DOCK_HEIGHT } from "./terminalAiDock";
import { useStickyAiBlockId } from "./useStickyAiBlockId";
import { useStickyActive } from "./useStickyActive";
import { cancelInlineAiBlock } from "./warpInlineAi";
import { useI18n } from "../../i18n";
import { stripAutoLsSuffix } from "./terminalAutoLs";
import { shouldUseDirectoryPreview } from "./terminalDirectoryPreview";
import { EnrichedLsListingView } from "./lsListing/EnrichedLsListingView";
import { tryParseLsListing } from "./lsListing/parseLsListing";
import { resolveShellOutputCwd, resolveCdDestination } from "./lsListing/resolveLsListingDirectory";
import { TerminalPathBreadcrumb } from "./TerminalPathBreadcrumb";
import type { TerminalSessionType } from "../../stores/terminalStore";
import { groupFeedBlocksIntoSegments, type FeedAiRunSegment } from "./terminalFeedSegments";
import {
  FOLLOW_OUTPUT_PIN_THRESHOLD_PX,
  isScrollPinnedToBottom,
} from "./useFollowOutputScroll";

type TerminalBlockFeedProps = {
  sessionId: string;
  resourceId?: string;
  promptSymbol?: string;
  onRunCommand?: (command: string) => void;
  sessionType?: TerminalSessionType;
  sessionUser?: string | null;
};

function blockTitle(block: TerminalBlock): string {
  if (block.kind === "ai" && block.title?.trim()) return block.title.trim();
  const cmd = block.command.trim();
  if (cmd) return cmd;
  return "命令";
}

function shellOutput(block: TerminalBlock): string {
  const cleaned = extractCommandOutput(block.output, block.command);
  if (cleaned) {
    if (shouldUseDirectoryPreview(block) && isResidualShellNoise(cleaned)) return "";
    return cleaned;
  }
  if (isEchoOnlyTerminalOutput(block.output, block.command)) return "";
  if (isResidualShellNoise(stripTerminalControlSequences(block.output))) return "";
  return block.output.trim();
}

function formatDuration(block: TerminalBlock): string | null {
  if (!block.completedAt || block.status === "running") return null;
  const ms = block.completedAt - block.timestamp;
  if (ms < 0) return null;
  return `${(ms / 1000).toFixed(2)}s`;
}

function shouldRenderBlock(block: TerminalBlock): boolean {
  if (block.kind === "ai") return true;
  if (block.directoryPreview || block.attachedListing) return true;
  if (shouldUseDirectoryPreview(block)) return true;
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
      return `sh:${block.id}:${block.status}:${block.output.length}:${shellOutput(block).length}:${block.attachedListing?.entries.length ?? 0}`;
    })
    .join(";");
}

/** 不含 AI 线程文本增量，用于区分「仅流式输出」与「结构变化」 */
function buildFeedShellSignature(blocks: TerminalBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "ai") {
        return `ai:${block.id}:${block.status}`;
      }
      return `sh:${block.id}:${block.status}:${block.output.length}:${shellOutput(block).length}:${block.attachedListing?.entries.length ?? 0}`;
    })
    .join(";");
}

function scrollFeedToLatest(container: HTMLElement) {
  container.scrollTop = container.scrollHeight;
}

const FEED_SCROLL_PIN_THRESHOLD_PX = FOLLOW_OUTPUT_PIN_THRESHOLD_PX;

function scrollFeedToLatestIfFollowing(
  container: HTMLElement,
  followOutput: boolean,
) {
  if (!followOutput) return;
  scrollFeedToLatest(container);
}

function AiBlockStopButton({
  block,
  sessionId,
}: {
  block: TerminalBlock;
  sessionId: string;
}) {
  const { t } = useI18n();
  if (block.status !== "running") return null;

  return (
    <button
      type="button"
      className="term-warp-block__stop"
      aria-label={t("terminal.ai.stop")}
      title={t("terminal.ai.stop")}
      onClick={(event) => {
        event.stopPropagation();
        cancelInlineAiBlock(sessionId, block.id);
      }}
    >
      ■
    </button>
  );
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
  const stickyHostRef = useRef<HTMLDivElement>(null);
  const [naturalHeight, setNaturalHeight] = useState(0);
  const prevStickyActiveRef = useRef(false);
  const threadSignature = useMemo(() => {
    const thread = getResolvedAiThread(block);
    return thread
      .map((item) => {
        if (item.kind === "message") {
          return `m:${item.id}:${item.content.length}:${item.reasoning?.length ?? 0}`;
        }
        return `t:${item.id}:${item.status}:${item.result?.length ?? 0}`;
      })
      .join("|");
  }, [block]);

  useLayoutEffect(() => {
    const host = stickyHostRef.current;
    if (!host || !expanded) return;

    const measure = () => {
      if (isStickyActive) return;
      const next = host.offsetHeight;
      setNaturalHeight((prev) => (next > prev ? next : prev));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [isStickyActive, threadSignature, dockMaxHeight, expanded]);

  useLayoutEffect(() => {
    const feed = feedScrollRef.current;
    const host = stickyHostRef.current;
    const justActivated = isStickyActive && !prevStickyActiveRef.current;
    prevStickyActiveRef.current = isStickyActive;

    if (!justActivated || !expanded || !feed || !host) return;

    const measured = Math.max(naturalHeight, host.scrollHeight);
    if (measured > naturalHeight) {
      setNaturalHeight(measured);
    }

    const savedScrollTop = feed.scrollTop;
    const thread = host.querySelector<HTMLElement>(".term-warp-ai-thread");
    if (thread) {
      const feedTop = feed.getBoundingClientRect().top;
      const contentTop = thread.getBoundingClientRect().top;
      thread.scrollTop = Math.max(0, feedTop - contentTop);
    }

    feed.scrollTop = savedScrollTop;
  }, [isStickyActive, expanded, feedScrollRef, naturalHeight]);

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
            <AiBlockStopButton block={block} sessionId={sessionId} />
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
          <AiBlockStopButton block={block} sessionId={sessionId} />
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
        >
          <button type="button" className="term-warp-block__summary" onClick={onToggle}>
            <span className="term-warp-ai-mark" aria-hidden>
              AI
            </span>
            <AiStatusIcon block={block} />
            <span className="term-warp-block__title">{blockTitle(block)}</span>
            <AiBlockStopButton block={block} sessionId={sessionId} />
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
        <AiBlockStopButton block={block} sessionId={sessionId} />
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
        ref={stickyHostRef}
        className={`term-warp-ai-sticky-host${
          isStickyActive ? " term-warp-ai-sticky-host--active" : ""
        }`}
        style={isStickyActive ? { maxHeight: dockMaxHeight } : undefined}
      >
        {article}
        {isStickyActive ? <AiDockResizeHandle sessionId={sessionId} /> : null}
      </div>
    </>
  );
}

function ShellBlockCard({
  block,
  sessionId,
  resourceId,
  promptSymbol = "$",
  onRunCommand,
  sessionType = "remote",
  sessionUser,
}: {
  block: TerminalBlock;
  sessionId: string;
  resourceId?: string;
  promptSymbol?: string;
  onRunCommand?: (command: string) => void;
  sessionType?: TerminalSessionType;
  sessionUser?: string | null;
}) {
  const output = shellOutput(block);
  const duration = formatDuration(block);
  const running = block.status === "running";
  const cmd = stripAutoLsSuffix(normalizeBlockCommand(block.command));
  const isError =
    block.status === "failed" || (block.exitCode !== null && block.exitCode !== 0);

  const lsListing = useMemo(() => {
    if (block.attachedListing) return block.attachedListing;
    if (!output || isError) return null;
    return tryParseLsListing(block.command, output);
  }, [block.attachedListing, block.command, output, isError]);

  const listingCwd =
    resolveShellOutputCwd(block.output) ||
    resolveCdDestination(cmd, block.cwd, sessionUser) ||
    block.cwd;
  const directoryPreview = shouldUseDirectoryPreview(block);
  const showCommandLine = !directoryPreview && cmd.length > 0;

  return (
    <article className="term-warp-block term-warp-block--shell" data-block-id={block.id}>
      {showCommandLine ? (
        <div className="term-warp-prompt-line">
          <TerminalPathBreadcrumb
            cwd={listingCwd}
            user={sessionUser}
            sessionType={sessionType}
            onRunCommand={onRunCommand}
            variant="block"
          />
          <span className="term-warp-prompt-line__symbol">{promptSymbol}</span>
          <span className="term-warp-prompt-line__cmd">{cmd}</span>
          {duration ? <span className="term-warp-prompt-line__dur">{duration}</span> : null}
          {running && !directoryPreview && !output && !block.attachedListing ? (
            <span className="term-warp-prompt-line__spinner" aria-label="执行中" />
          ) : null}
        </div>
      ) : directoryPreview ? (
        <div className="term-warp-prompt-line">
          <TerminalPathBreadcrumb
            cwd={listingCwd}
            user={sessionUser}
            sessionType={sessionType}
            onRunCommand={onRunCommand}
            variant="block"
          />
        </div>
      ) : null}
      {lsListing ? (
        <EnrichedLsListingView
          listing={lsListing}
          command={block.attachedListing ? "ls" : block.command}
          cwd={listingCwd}
          sessionId={sessionId}
          sessionType={sessionType}
          sessionUser={sessionUser}
          resourceId={resourceId}
          rawOutput={block.output}
          fallbackOutput={output}
          isError={isError}
          onRunCommand={onRunCommand}
        />
      ) : output && !directoryPreview ? (
        <pre
          className={`term-warp-output${isError ? " term-warp-output--error" : ""}`}
        >
          {output}
        </pre>
      ) : null}
    </article>
  );
}

const MemoShellBlockCard = memo(ShellBlockCard);

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

function FeedAiRunSegmentView({
  segment,
  sessionId,
  resourceId,
  promptSymbol,
  expandedAiBlockId,
  setExpandedAiBlock,
  stickyAiBlockId,
  feedScrollRef,
  feedPinnedToBottom,
  onRunCommand,
  sessionType,
  sessionUser,
}: {
  segment: FeedAiRunSegment;
  sessionId: string;
  resourceId?: string;
  promptSymbol?: string;
  expandedAiBlockId: string | null;
  setExpandedAiBlock: (sessionId: string, blockId: string | null) => void;
  stickyAiBlockId: string | null;
  feedScrollRef: RefObject<HTMLElement | null>;
  feedPinnedToBottom: boolean;
  onRunCommand?: (command: string) => void;
  sessionType?: TerminalSessionType;
  sessionUser?: string | null;
}) {
  const { ai, shells } = segment;
  const thread = getResolvedAiThread(ai);
  const hasActiveTool = thread.some(
    (item) =>
      isAiThreadToolCall(item) &&
      (item.status === "pending" || item.status === "running"),
  );
  const expanded = resolveAiExpanded(ai, expandedAiBlockId);
  const isStickyCandidate = ai.id === stickyAiBlockId;

  const onToggle = () => {
    if (ai.status === "running" || hasActiveTool) return;
    if (expanded) {
      setExpandedAiBlock(sessionId, null);
    } else {
      setExpandedAiBlock(sessionId, ai.id);
    }
  };

  return (
    <div className="term-warp-sticky-segment" data-block-id={ai.id}>
      <AiBlockCard
        block={ai}
        sessionId={sessionId}
        expanded={expanded}
        onToggle={onToggle}
        isStickyCandidate={isStickyCandidate}
        feedScrollRef={feedScrollRef}
        feedPinnedToBottom={feedPinnedToBottom}
      />
      {shells.map((shell) => (
        <MemoShellBlockCard
          key={shell.id}
          block={shell}
          sessionId={sessionId}
          resourceId={resourceId}
          promptSymbol={promptSymbol}
          onRunCommand={onRunCommand}
          sessionType={sessionType}
          sessionUser={sessionUser}
        />
      ))}
    </div>
  );
}

/** Warp 式 Block 流：shell 与 AI 卡片按时间交错排列 */
export function TerminalBlockFeed({
  sessionId,
  resourceId,
  promptSymbol,
  onRunCommand,
  sessionType = "remote",
  sessionUser,
}: TerminalBlockFeedProps) {
  const blocks = useBlocksStore((state) => state.blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS);
  const expandedAiBlockId = useTerminalUiStore((state) => state.expandedAiBlockIds[sessionId] ?? null);
  const setExpandedAiBlock = useTerminalUiStore((state) => state.setExpandedAiBlock);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevBlockCountRef = useRef(0);
  /** 用户未主动上滚时持续跟随输出；内容增高后不能用即时 isFeedPinnedToBottom 判断 */
  const followOutputRef = useRef(true);
  const [feedPinnedToBottom, setFeedPinnedToBottom] = useState(true);
  const lastFeedScrollHeightRef = useRef(0);
  const prevActivitySignatureRef = useRef("");
  const prevShellSignatureRef = useRef("");
  const feedScrollRafRef = useRef(0);

  const visibleBlocks = blocks.filter(shouldRenderBlock);
  const feedSegments = useMemo(
    () => groupFeedBlocksIntoSegments(visibleBlocks),
    [visibleBlocks],
  );
  const activitySignature = useMemo(
    () => buildFeedActivitySignature(visibleBlocks),
    [visibleBlocks],
  );
  const shellSignature = useMemo(
    () => buildFeedShellSignature(visibleBlocks),
    [visibleBlocks],
  );
  const stickyAiBlockId = useStickyAiBlockId(scrollRef, listRef, visibleBlocks, activitySignature);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const syncPinned = () => {
      const scrollHeight = el.scrollHeight;
      const pinned = isScrollPinnedToBottom(
        el,
        FEED_SCROLL_PIN_THRESHOLD_PX,
        lastFeedScrollHeightRef.current,
      );
      lastFeedScrollHeightRef.current = scrollHeight;
      followOutputRef.current = pinned;
      setFeedPinnedToBottom((prev) => (prev === pinned ? prev : pinned));
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

    const onlyAiThreadStream =
      activitySignature !== prevActivitySignatureRef.current &&
      shellSignature === prevShellSignatureRef.current;
    prevActivitySignatureRef.current = activitySignature;
    prevShellSignatureRef.current = shellSignature;

    const stickyDockedStreaming = Boolean(
      onlyAiThreadStream &&
        el.querySelector(".term-warp-ai-sticky-host--active"),
    );

    if (!blockCountGrew && !followOutputRef.current) return;
    if (stickyDockedStreaming && !blockCountGrew) return;

    if (blockCountGrew) {
      followOutputRef.current = true;
      setFeedPinnedToBottom(true);
    }

    cancelAnimationFrame(feedScrollRafRef.current);
    feedScrollRafRef.current = requestAnimationFrame(() => {
      feedScrollRafRef.current = 0;
      if (!blockCountGrew && !followOutputRef.current) return;
      scrollFeedToLatest(el);
    });
  }, [activitySignature, shellSignature, visibleBlocks.length]);

  useEffect(() => {
    const list = listRef.current;
    const container = scrollRef.current;
    if (!list || !container) return;

    let resizeRaf = 0;
    const observer = new ResizeObserver(() => {
      if (!followOutputRef.current) return;
      if (container.querySelector(".term-warp-ai-sticky-host--active")) return;
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (!followOutputRef.current) return;
        scrollFeedToLatestIfFollowing(container, true);
      });
    });
    observer.observe(list);
    return () => {
      cancelAnimationFrame(resizeRaf);
      observer.disconnect();
    };
  }, [visibleBlocks.length]);

  useEffect(
    () => () => {
      cancelAnimationFrame(feedScrollRafRef.current);
    },
    [],
  );

  if (visibleBlocks.length === 0) return null;

  return (
    <div className="term-warp-feed" ref={scrollRef}>
      <div className="term-warp-feed__list" ref={listRef}>
        {feedSegments.map((segment) => {
          if (segment.kind === "orphan-shells") {
            return segment.blocks.map((block) => (
              <MemoShellBlockCard
                key={block.id}
                block={block}
                sessionId={sessionId}
                resourceId={resourceId}
                promptSymbol={promptSymbol}
                onRunCommand={onRunCommand}
                sessionType={sessionType}
                sessionUser={sessionUser}
              />
            ));
          }

          return (
            <FeedAiRunSegmentView
              key={segment.ai.id}
              segment={segment}
              sessionId={sessionId}
              resourceId={resourceId}
              promptSymbol={promptSymbol}
              expandedAiBlockId={expandedAiBlockId}
              setExpandedAiBlock={setExpandedAiBlock}
              stickyAiBlockId={stickyAiBlockId}
              feedScrollRef={scrollRef}
              feedPinnedToBottom={feedPinnedToBottom}
              onRunCommand={onRunCommand}
              sessionType={sessionType}
              sessionUser={sessionUser}
            />
          );
        })}
      </div>
    </div>
  );
}
