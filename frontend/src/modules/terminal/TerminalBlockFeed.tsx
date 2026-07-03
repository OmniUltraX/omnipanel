import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { useStickyActive } from "./useStickyActive";
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
  block,
  sessionId,
  expanded,
  onToggle,
  isStickyCandidate,
  feedScrollRef,
  feedPinnedToBottom,
  onFocusInput,
}: {
  block: TerminalBlock;
  sessionId: string;
  expanded: boolean;
  onToggle: () => void;
  /** 当前视口上下文中可吸顶的 AI 候选 */
  isStickyCandidate?: boolean;
  feedScrollRef: RefObject<HTMLElement | null>;
  feedPinnedToBottom: boolean;
  onFocusInput?: () => void;
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

  // 仅「流式输出中 + feed 贴底」时让 dock 自动跟随最新输出；其余（静态浏览）交给
  // 下方的进度同步 effect，避免 autoScroll 把 thread 锁到底、覆盖用户浏览进度。
  const dockAutoScroll =
    isStickyActive && feedPinnedToBottom && block.status === "running";

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
    const host = stickyHostRef.current;
    const justActivated = isStickyActive && !prevStickyActiveRef.current;
    prevStickyActiveRef.current = isStickyActive;

    if (!justActivated || !expanded || !host) return;

    // 吸顶瞬间补测一次完整高度，确保 spacer 占位（naturalHeight - dockMaxHeight）够。
    const measured = Math.max(naturalHeight, host.scrollHeight);
    if (measured > naturalHeight) {
      setNaturalHeight(measured);
    }
  }, [isStickyActive, expanded, naturalHeight]);

  // 吸顶期间：dock 内 AI 进度按「不吸顶时视口底部所见」对齐——dock 底部显示的内容
  // 等于你没吸顶时那一屏底部正在看的 AI 内容（按底部为准）。feed 滚动实时驱动，
  // dock 内容跟随。命令 shell 已由 CSS order 紧跟在 dock 下方（spacer 排到末尾），
  // 故 dock 底部对齐 + 命令紧跟可兼得、无中间空白。
  // dockAutoScroll（流式贴底跟随）激活时跳过，避免与自动滚底互相打架。
  useLayoutEffect(() => {
    const feed = feedScrollRef.current;
    const host = stickyHostRef.current;
    if (!isStickyActive || !expanded || !feed || !host || !sentinelEl) return;
    if (dockAutoScroll) return;

    let raf = 0;
    const sync = () => {
      raf = 0;
      const thread = host.querySelector<HTMLElement>(".term-warp-ai-thread");
      if (!thread) return;
      const feedRect = feed.getBoundingClientRect();
      const sentinelTop = sentinelEl.getBoundingClientRect().top;
      const hostTop = host.getBoundingClientRect().top;
      const threadTop = thread.getBoundingClientRect().top;
      // host 顶滚出 feed 顶部的量
      const scrolledPast = feedRect.top - sentinelTop;
      // dock 内 header 高度（thread 容器顶相对 host 顶）
      const headerHeight = threadTop - hostTop;
      // feed 视口底部落在 thread 内容坐标系中的位置
      const viewportBottomInThread =
        scrolledPast + feedRect.height - headerHeight;
      // 让 dock 底部（可见区底）对齐该位置 → 按底部为准
      const target = viewportBottomInThread - thread.clientHeight;
      const max = Math.max(0, thread.scrollHeight - thread.clientHeight);
      thread.scrollTop = Math.min(Math.max(0, target), max);
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(sync);
    };

    sync();
    feed.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      feed.removeEventListener("scroll", onScroll);
    };
  }, [isStickyActive, expanded, feedScrollRef, sentinelEl, dockAutoScroll]);

  // 吸顶时 host 从自然高度 naturalHeight 塌缩到 dockMaxHeight，文档流骤减
  // (naturalHeight - dockMaxHeight)。若占位补位晚于塌缩一帧（用 effect+setState 异步补），
  // 中间那一帧 scrollHeight 骤减 → 浏览器夹回 scrollTop → 哨兵回视口 → 取消吸顶 →
  // 高度恢复 → 再吸顶，形成闪烁。
  //
  // 修复：占位高度在「渲染期同步计算」，与 host 塌缩落在同一次 commit，无时序 gap。
  // 占位 = 塌缩损失，使 segment 吸顶前后总高恒定 (dockMaxHeight + spacer == naturalHeight)，
  // scrollHeight 不变 → scrollTop 不被夹 → 哨兵不回弹 → 不闪烁。
  // 段内 host 下方若有 shell，会多补该高度（宁可略多空白也不可少补导致塌陷）。
  const stickyFlowSpacerHeight =
    isStickyActive && expanded ? Math.max(0, naturalHeight - dockMaxHeight) : 0;

  if (!isStickyCandidate) {
    if (!expanded) {
      return (
        <article
          className="term-warp-block term-warp-block--ai term-warp-block--collapsed"
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
        className="term-warp-block term-warp-block--ai term-warp-block--expanded"
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
          <AiBlockSummary block={block} expanded={false} onToggle={onToggle} />
          <AiBlockHeaderActions
            block={block}
            sessionId={sessionId}
            expanded={false}
            onToggle={onToggle}
            onFocusInput={onFocusInput}
          />
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
      <TerminalAiThreadView blockId={block.id} dockedAutoScroll={dockAutoScroll} />
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
      {stickyFlowSpacerHeight > 0 ? (
        <div
          className="term-warp-ai-sticky-flow-spacer"
          style={{ height: stickyFlowSpacerHeight }}
          aria-hidden
        />
      ) : null}
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
  feedScrollRef,
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
  feedScrollRef: RefObject<HTMLElement | null>;
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
      <AiBlockCard
        block={ai}
        sessionId={sessionId}
        expanded={expanded}
        onToggle={onToggle}
        isStickyCandidate={isStickyCandidate}
        feedScrollRef={feedScrollRef}
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
              feedScrollRef={scrollRef}
              feedPinnedToBottom={feedPinnedToBottom}
              onRunCommand={onRunCommand}
              sessionType={sessionType}
              sessionUser={sessionUser}
              onFocusInput={onFocusInput}
            />
          );
        })}
      </div>
    </div>
  );
}
