import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_TERMINAL_BLOCKS,
  useBlocksStore,
  type TerminalBlock,
} from "../../stores/blocksStore";
import { extractCommandOutput, isEchoOnlyTerminalOutput, normalizeBlockCommand, stripTerminalControlSequences } from "./terminalOutputText";
import { isResidualShellNoise } from "./terminalCommandEcho";
import { useTerminalUiStore } from "./terminalUiStore";
import { TerminalAiThreadView } from "./TerminalAiThreadView";
import { getResolvedAiThread } from "./aiThreadBridge";
import { AiDockResizeHandle } from "./AiDockResizeHandle";
import { DEFAULT_AI_DOCK_HEIGHT } from "./terminalAiDock";
import { useStickyAiBlockId } from "./useStickyAiBlockId";
import { cancelInlineAiBlock } from "./warpInlineAi";
import { useI18n } from "../../i18n";
import { stripAutoLsSuffix } from "./terminalAutoLs";
import { shouldUseDirectoryPreview } from "./terminalDirectoryPreview";
import { EnrichedLsListingView } from "./lsListing/EnrichedLsListingView";
import { tryParseLsListing } from "./lsListing/parseLsListing";
import { resolveShellOutputCwd, resolveCdDestination } from "./lsListing/resolveLsListingDirectory";
import { TerminalPathBreadcrumb } from "./TerminalPathBreadcrumb";
import {
  IconChevronDown,
  IconChevronRight,
  IconClipboard,
  IconCopy,
} from "../../components/ui/Icons";
import { showToast } from "../../stores/toastStore";
import { BlockAttachToAiButton } from "./BlockAttachToAiButton";
import type { TerminalSessionType } from "../../stores/terminalStore";
import { groupFeedBlocksIntoSegments, type FeedAiRunSegment } from "./terminalFeedSegments";
import {
  FOLLOW_OUTPUT_PIN_THRESHOLD_PX,
  isScrollPinnedToBottom,
} from "./useFollowOutputScroll";
import { useTerminalCopyContextMenu } from "./terminalTextSelection";

type TerminalBlockFeedProps = {
  sessionId: string;
  resourceId?: string;
  promptSymbol?: string;
  onRunCommand?: (command: string) => void;
  sessionType?: TerminalSessionType;
  sessionUser?: string | null;
  onFocusInput?: () => void;
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

function AiBlockHeaderActions({
  block,
  sessionId,
  expanded,
  onToggle,
  onFocusInput,
}: {
  block: TerminalBlock;
  sessionId: string;
  expanded: boolean;
  onToggle: () => void;
  onFocusInput?: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="term-warp-block__header-actions">
      <BlockAttachToAiButton block={block} sessionId={sessionId} onFocusInput={onFocusInput} />
      <button
        type="button"
        className="term-warp-block__toolbar-btn term-warp-block__toggle"
        aria-label={expanded ? t("terminal.ai.collapse") : t("terminal.ai.expand")}
        title={expanded ? t("terminal.ai.collapse") : t("terminal.ai.expand")}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <IconChevronRight
          size={14}
          className={`term-warp-block__chevron${expanded ? " term-warp-block__chevron--open" : ""}`}
        />
      </button>
      <AiBlockStopButton block={block} sessionId={sessionId} />
    </div>
  );
}

function AiBlockSummary({
  block,
  expanded,
  onToggle,
}: {
  block: TerminalBlock;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`term-warp-block__summary${expanded ? " term-warp-block__summary--open" : ""}`}
      onClick={onToggle}
    >
      <span className="term-warp-ai-mark" aria-hidden>
        AI
      </span>
      <AiStatusIcon block={block} />
      <span className="term-warp-block__title">{blockTitle(block)}</span>
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
  blockId,
  sessionId,
  expanded,
  onToggle,
  isStickyCandidate,
  feedPinnedToBottom,
  onFocusInput,
}: {
  blockId: string;
  sessionId: string;
  expanded: boolean;
  onToggle: () => void;
  /** 当前视口上下文中可吸顶的 AI 候选 */
  isStickyCandidate?: boolean;
  feedPinnedToBottom: boolean;
  onFocusInput?: () => void;
}) {
  const block = useBlocksStore((state) => state.findBlockById(blockId));
  const dockMaxHeight = useTerminalUiStore(
    (state) => state.aiDockHeights[sessionId] ?? DEFAULT_AI_DOCK_HEIGHT,
  );

  const dockAutoScroll = Boolean(
    block?.kind === "ai" &&
      isStickyCandidate &&
      expanded &&
      feedPinnedToBottom &&
      block.status === "running",
  );

  if (!block || block.kind !== "ai") return null;

  const stickyClass = isStickyCandidate ? " term-warp-block--ai-sticky" : "";
  const dockClass =
    isStickyCandidate && expanded ? " term-warp-block--ai-sticky-docked" : "";

  if (!expanded) {
    return (
      <article
        className={`term-warp-block term-warp-block--ai term-warp-block--collapsed${stickyClass}`}
        data-block-id={block.id}
      >
        <AiBlockSummary block={block} expanded={false} onToggle={onToggle} />
        <AiBlockHeaderActions
          block={block}
          sessionId={sessionId}
          expanded={false}
          onToggle={onToggle}
          onFocusInput={onFocusInput}
        />
      </article>
    );
  }

  return (
    <article
      className={`term-warp-block term-warp-block--ai term-warp-block--expanded${stickyClass}${dockClass}`}
      style={isStickyCandidate ? { maxHeight: dockMaxHeight } : undefined}
      data-block-id={block.id}
    >
      <header className="term-warp-block__header">
        <AiBlockSummary block={block} expanded onToggle={onToggle} />
        <span className="term-warp-block__badge">助手</span>
        <AiBlockHeaderActions
          block={block}
          sessionId={sessionId}
          expanded
          onToggle={onToggle}
          onFocusInput={onFocusInput}
        />
      </header>
      <TerminalAiThreadView
        blockId={block.id}
        dockedAutoScroll={dockAutoScroll}
      />
      {isStickyCandidate ? <AiDockResizeHandle sessionId={sessionId} /> : null}
    </article>
  );
}

const MemoAiBlockCard = memo(AiBlockCard, (prev, next) =>
  prev.blockId === next.blockId &&
  prev.sessionId === next.sessionId &&
  prev.expanded === next.expanded &&
  prev.isStickyCandidate === next.isStickyCandidate &&
  prev.feedPinnedToBottom === next.feedPinnedToBottom &&
  prev.onFocusInput === next.onFocusInput,
);

function ShellBlockCard({
  block,
  sessionId,
  resourceId,
  promptSymbol = "$",
  onRunCommand,
  sessionType = "remote",
  sessionUser,
  onFocusInput,
}: {
  block: TerminalBlock;
  sessionId: string;
  resourceId?: string;
  promptSymbol?: string;
  onRunCommand?: (command: string) => void;
  sessionType?: TerminalSessionType;
  sessionUser?: string | null;
  onFocusInput?: () => void;
}) {
  // 稳定 output 引用：避免 useSftpEnrichedLsListing effect 频繁 cleanup 导致
  // SFTP fetch promise 反复被 cancelled（首次 cd 后 listing 已渲染但 SFTP 拉不到）
  const output = useMemo(
    () => shellOutput(block),
    [block.attachedListing, block.command, block.output, block.status],
  );
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

  const hasOutputBody = !!lsListing || (!!output && !directoryPreview);
  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const outputLineCount = useMemo(() => {
    const text = lsListing ? output || block.output : output;
    if (!text) return 0;
    return text.replace(/\n+$/, "").split("\n").length;
  }, [lsListing, output, block.output]);

  const copyToClipboard = async (text: string, okMsg: string) => {
    const value = text.trim();
    if (!value) {
      showToast("没有可复制的内容");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      showToast(okMsg);
    } catch {
      showToast("复制失败");
    }
  };


  return (
    <article className="term-warp-block term-warp-block--shell" data-block-id={block.id}>
      <div className="term-warp-block__toolbar" role="toolbar" aria-label="命令操作">
        {hasOutputBody ? (
          <button
            type="button"
            className="term-warp-block__toolbar-btn"
            title={outputCollapsed ? "展开输出" : "折叠输出"}
            aria-label={outputCollapsed ? "展开输出" : "折叠输出"}
            onClick={() => setOutputCollapsed((v) => !v)}
          >
            {outputCollapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
          </button>
        ) : null}
        <BlockAttachToAiButton block={block} sessionId={sessionId} onFocusInput={onFocusInput} />
        <button
          type="button"
          className="term-warp-block__toolbar-btn"
          title="复制命令"
          aria-label="复制命令"
          onClick={() => copyToClipboard(cmd || normalizeBlockCommand(block.command), "已复制命令")}
        >
          <IconCopy size={14} />
        </button>
        {hasOutputBody ? (
          <button
            type="button"
            className="term-warp-block__toolbar-btn"
            title="复制输出"
            aria-label="复制输出"
            onClick={() => copyToClipboard(output || block.output, "已复制输出")}
          >
            <IconClipboard size={14} />
          </button>
        ) : null}
      </div>
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
      {outputCollapsed && hasOutputBody ? (
        <button
          type="button"
          className="term-warp-output-collapsed"
          onClick={() => setOutputCollapsed(false)}
        >
          <IconChevronRight size={13} />
          <span>输出已折叠 {outputLineCount} 行</span>
        </button>
      ) : lsListing ? (
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
  return expandedAiBlockId === block.id;
}

function FeedAiRunSegmentView({
  segment,
  sessionId,
  resourceId,
  promptSymbol,
  expandedAiBlockId,
  setExpandedAiBlock,
  stickyAiBlockId,
  feedPinnedToBottom,
  onRunCommand,
  sessionType,
  sessionUser,
  onFocusInput,
}: {
  segment: FeedAiRunSegment;
  sessionId: string;
  resourceId?: string;
  promptSymbol?: string;
  expandedAiBlockId: string | null;
  setExpandedAiBlock: (sessionId: string, blockId: string | null) => void;
  stickyAiBlockId: string | null;
  feedPinnedToBottom: boolean;
  onRunCommand?: (command: string) => void;
  sessionType?: TerminalSessionType;
  sessionUser?: string | null;
  onFocusInput?: () => void;
}) {
  const { ai, shells } = segment;
  const expanded = resolveAiExpanded(ai, expandedAiBlockId);
  const isStickyCandidate = ai.id === stickyAiBlockId;

  const onToggle = () => {
    if (expanded) {
      setExpandedAiBlock(sessionId, null);
    } else {
      setExpandedAiBlock(sessionId, ai.id);
    }
  };

  return (
    <div className="term-warp-sticky-segment" data-block-id={ai.id}>
      <MemoAiBlockCard
        blockId={ai.id}
        sessionId={sessionId}
        expanded={expanded}
        onToggle={onToggle}
        isStickyCandidate={isStickyCandidate}
        feedPinnedToBottom={feedPinnedToBottom}
        onFocusInput={onFocusInput}
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
          onFocusInput={onFocusInput}
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
  onFocusInput,
}: TerminalBlockFeedProps) {
  const blocks = useBlocksStore((state) => state.blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS);
  const { t } = useI18n();
  const expandedAiBlockId = useTerminalUiStore((state) => state.expandedAiBlockIds[sessionId] ?? null);
  const setExpandedAiBlock = useTerminalUiStore((state) => state.setExpandedAiBlock);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevBlockCountRef = useRef(0);
  /** 用户未主动上滚时持续跟随输出；内容增高后不能用即时 isFeedPinnedToBottom 判断 */
  const followOutputRef = useRef(true);
  const [feedPinnedToBottom, setFeedPinnedToBottom] = useState(true);
  const [feedCanScroll, setFeedCanScroll] = useState(false);
  const [feedAtTop, setFeedAtTop] = useState(true);
  const lastFeedScrollHeightRef = useRef(0);
  const prevActivitySignatureRef = useRef("");
  const prevShellSignatureRef = useRef("");
  const feedScrollRafRef = useRef(0);

  useTerminalCopyContextMenu(scrollRef);

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
  const stickyAiBlockId = useStickyAiBlockId(scrollRef, listRef, visibleBlocks, shellSignature);

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
      // 滚动条状态：内容超出 / 顶部
      const canScroll = scrollHeight - el.clientHeight > 1;
      setFeedCanScroll((prev) => (prev === canScroll ? prev : canScroll));
      const atTop = el.scrollTop <= 1;
      setFeedAtTop((prev) => (prev === atTop ? prev : atTop));
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

    if (!blockCountGrew && onlyAiThreadStream) return;
    if (!blockCountGrew && !followOutputRef.current) return;

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

  // 首次挂载（容器从无到有）强制跳到底 —— 用户打开 tab 时直接看最新输出
  const didMountRef = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (didMountRef.current) return;
    didMountRef.current = true;
    // 下一帧再跳（等 listRef 已渲染）
    requestAnimationFrame(() => {
      const target = scrollRef.current;
      if (!target) return;
      target.scrollTop = target.scrollHeight;
      followOutputRef.current = true;
      setFeedPinnedToBottom(true);
    });
  }, [visibleBlocks.length]);

  const scrollFeedToTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: "smooth" });
    followOutputRef.current = false;
    setFeedPinnedToBottom(false);
  }, []);

  const scrollFeedToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    followOutputRef.current = true;
    setFeedPinnedToBottom(true);
  }, []);

  useEffect(() => {
    const list = listRef.current;
    const container = scrollRef.current;
    if (!list || !container) return;

    let resizeRaf = 0;
    const syncScrollState = () => {
      const canScroll = container.scrollHeight - container.clientHeight > 1;
      setFeedCanScroll((prev) => (prev === canScroll ? prev : canScroll));
      const atTop = container.scrollTop <= 1;
      setFeedAtTop((prev) => (prev === atTop ? prev : atTop));
    };
    const observer = new ResizeObserver(() => {
      syncScrollState();
      if (!followOutputRef.current) return;
      if (container.querySelector(".term-warp-block--ai-sticky-docked")) return;
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
                onFocusInput={onFocusInput}
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
              feedPinnedToBottom={feedPinnedToBottom}
              onRunCommand={onRunCommand}
              sessionType={sessionType}
              sessionUser={sessionUser}
              onFocusInput={onFocusInput}
            />
          );
        })}
      </div>
      <div
        className={`term-warp-feed__scroll-controls${
          feedCanScroll ? " is-visible" : ""
        }`}
        data-pinned-to-bottom={feedPinnedToBottom ? "true" : "false"}
        data-at-top={feedAtTop ? "true" : "false"}
      >
        <button
          type="button"
          className={`term-warp-feed__scroll-btn${
            !feedAtTop ? " is-shown" : ""
          }`}
          aria-label={t("terminal.feed.scrollToTop")}
          title={t("terminal.feed.scrollToTop")}
          onClick={scrollFeedToTop}
        >
          ▲
        </button>
        <button
          type="button"
          className={`term-warp-feed__scroll-btn${
            !feedPinnedToBottom ? " is-shown" : ""
          }`}
          aria-label={t("terminal.feed.scrollToBottom")}
          title={t("terminal.feed.scrollToBottom")}
          onClick={scrollFeedToBottomNow}
        >
          ▼
        </button>
      </div>
    </div>
  );
}
