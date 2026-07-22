import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  EMPTY_TERMINAL_BLOCKS,
  useBlocksStore,
  type TerminalBlock,
} from "../../stores/blocksStore";
import {
  collapseProgressOutputText,
  renderLiveOutputText,
} from "./terminalOutputModel";
import { extractCommandOutput, isEchoOnlyTerminalOutput, normalizeBlockCommand, stripTerminalControlSequences } from "./terminalOutputText";
import { isResidualShellNoise } from "./terminalCommandEcho";
import { useTerminalUiStore } from "./terminalUiStore";
import { TerminalAiThreadView } from "./TerminalAiThreadView";
import { getResolvedAiThread } from "./aiThreadBridge";
import { AiDockResizeHandle } from "./AiDockResizeHandle";
import { DEFAULT_AI_DOCK_HEIGHT } from "./terminalAiDock";
import { useStickyAiBlockId } from "./useStickyAiBlockId";
import { cancelInlineAiBlock } from "./warpInlineAi";
import { interruptShell } from "./terminalShellRecovery";
import { useI18n } from "../../i18n";
import { stripAutoLsSuffix } from "./terminalAutoLs";
import { shouldUseDirectoryPreview } from "./terminalDirectoryPreview";
import { EnrichedLsListingView } from "./lsListing/EnrichedLsListingView";
import { tryParseLsListing } from "./lsListing/parseLsListing";
import { resolveShellOutputCwd, resolveCdDestination } from "./lsListing/resolveLsListingDirectory";
import { hasShellErrorSignals } from "./commandInputRouting";
import { TerminalPathBreadcrumb } from "./TerminalPathBreadcrumb";
import {
  IconChevronRight,
  IconClipboard,
  IconClose,
  IconCopy,
} from "../../components/ui/icons/Icons";
import { appConfirm } from "../../lib/appConfirm";
import { showToast } from "../../stores/toastStore";
import { focusTerminalTab } from "../../lib/terminalSession";
import { BlockAttachToAiButton } from "./BlockAttachToAiButton";
import type { TerminalSessionType } from "../../stores/terminalStore";
import { groupFeedBlocksIntoSegments, findExpandedAiSegmentIndex, type FeedAiRunSegment } from "./terminalFeedSegments";
import {
  FOLLOW_OUTPUT_PIN_THRESHOLD_PX,
  isScrollPinnedToBottom,
} from "./useFollowOutputScroll";
import { useTerminalCopyContextMenu } from "./terminalTextSelection";
import { scrollTerminalBlockIntoView } from "./scrollTerminalBlockIntoView";
import { FeedSearchBar } from "./FeedSearchBar";
import { FeedSearchHighlightText } from "./FeedSearchHighlightText";
import {
  DEFAULT_FEED_SEARCH_FILTERS,
  isFeedSearchFiltering,
  listFeedSearchMatchIds,
  type FeedSearchFilters,
} from "./feedSearchModel";

type TerminalBlockFeedProps = {
  sessionId: string;
  resourceId?: string;
  promptSymbol?: string;
  onRunCommand?: (command: string) => void;
  sessionType?: TerminalSessionType;
  sessionUser?: string | null;
  onFocusInput?: () => void;
  /**
   * 当前 tab 是否处于激活可见状态。dockview 切换 tab 时非激活 panel 仅 display:none 隐藏，
   * 此 prop 用于在从隐藏切回可见时重新对齐滚动位置与状态测量。
   * 默认 true（嵌入用法无需关心）。
   */
  isActive?: boolean;
};

function blockTitle(block: TerminalBlock): string {
  if (block.kind === "ai" && block.title?.trim()) return block.title.trim();
  const cmd = block.command.trim();
  if (cmd) return cmd;
  return "命令";
}

function blockRawOutput(block: TerminalBlock): string {
  const raw = renderLiveOutputText(block.liveOutput, block.output);
  return collapseProgressOutputText(raw);
}

function blockListingSource(block: TerminalBlock): string {
  const raw = blockRawOutput(block);
  const cleaned = extractCommandOutput(raw, block.command);
  return cleaned || raw.trim();
}

function shellOutput(block: TerminalBlock): string {
  const source = blockRawOutput(block);
  const cleaned = extractCommandOutput(source, block.command);
  if (cleaned) {
    if (shouldUseDirectoryPreview(block) && isResidualShellNoise(cleaned)) return "";
    return cleaned;
  }
  if (isEchoOnlyTerminalOutput(source, block.command)) return "";
  if (isResidualShellNoise(stripTerminalControlSequences(source))) return "";
  return source.trim();
}

function formatDuration(block: TerminalBlock): string | null {
  if (!block.completedAt || block.status === "running") return null;
  const ms = block.completedAt - block.timestamp;
  if (ms < 0) return null;
  return `${(ms / 1000).toFixed(2)}s`;
}

function shouldRenderBlock(block: TerminalBlock): boolean {
  if (block.silent) return false;
  if (block.kind === "ai") return true;
  if (block.directoryPreview || block.attachedListing) return true;
  if (shouldUseDirectoryPreview(block)) return true;
  const cmd = block.command.trim();
  if (!cmd) return false;
  // 有命令即展示：避免 cd / 空输出命令在刷新恢复后因无 liveOutput 被隐藏
  return true;
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
              const partsSig = item.parts
                ? item.parts.map((p) => p.type === "text" || p.type === "reasoning" ? `${p.type}:${p.text.length}` : `tc:${p.id}:${p.status}`).join(",")
                : "";
              return `m:${item.id}:${item.content.length}:${item.reasoning?.length ?? 0}:${partsSig}`;
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

function BlockCollapseFooter({
  collapsed,
  onToggle,
  lineCount = 0,
  variant = "shell",
  showCollapse = true,
  actions,
}: {
  collapsed: boolean;
  onToggle: () => void;
  lineCount?: number;
  variant?: "shell" | "ai";
  showCollapse?: boolean;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const label = collapsed
    ? lineCount > 0
      ? t("terminal.feed.collapsedLines", { count: lineCount })
      : t("terminal.feed.expandBlock")
    : t("terminal.feed.collapseBlock");

  const footerClass = [
    "term-warp-block__footer",
    `term-warp-block__footer--${variant}`,
    !showCollapse && actions ? "term-warp-block__footer--actions-only" : "",
    showCollapse && collapsed ? "term-warp-block__footer--collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={footerClass}>
      {showCollapse ? (
        <button
          type="button"
          className="term-warp-block__collapse-btn"
          aria-expanded={!collapsed}
          aria-label={label}
          title={label}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <IconChevronRight
            size={12}
            className={`term-warp-block__collapse-icon${
              collapsed ? "" : " term-warp-block__collapse-icon--expanded"
            }`}
          />
          <span className="term-warp-block__collapse-label">{label}</span>
        </button>
      ) : null}
      {actions}
    </div>
  );
}

async function copyBlockText(text: string, okMsg: string) {
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
}

function ShellBlockStopButton({ sessionId, running }: { sessionId: string; running: boolean }) {
  const { t } = useI18n();
  if (!running) return null;

  return (
    <button
      type="button"
      className="term-warp-block__stop"
      aria-label={t("terminal.feed.stop")}
      title={t("terminal.feed.stop")}
      onClick={(event) => {
        event.stopPropagation();
        void interruptShell(sessionId);
      }}
    >
      ■
    </button>
  );
}

function ShellBlockToolbar({
  block,
  sessionId,
  cmd,
  output,
  hasOutputBody,
  onFocusInput,
}: {
  block: TerminalBlock;
  sessionId: string;
  cmd: string;
  output: string;
  hasOutputBody: boolean;
  onFocusInput?: () => void;
}) {
  const { t } = useI18n();
  const removeBlock = useBlocksStore((s) => s.removeBlock);
  const running = block.status === "running";

  const handleDelete = async () => {
    const ok = await appConfirm(
      t("terminal.feed.deleteBlockConfirm"),
      t("terminal.feed.deleteBlock"),
      { kind: "warning", confirmLabel: t("terminal.feed.confirmAction") },
    );
    if (!ok) return;
    removeBlock(block.id);
    showToast(t("terminal.feed.deleteBlockDone"));
  };

  return (
    <div className="term-warp-block__toolbar" role="toolbar" aria-label="命令操作">
      <ShellBlockStopButton sessionId={sessionId} running={running} />
      <BlockAttachToAiButton block={block} sessionId={sessionId} onFocusInput={onFocusInput} />
      <button
        type="button"
        className="term-warp-block__toolbar-btn"
        title="复制命令"
        aria-label="复制命令"
        onClick={() => copyBlockText(cmd || normalizeBlockCommand(block.command), "已复制命令")}
      >
        <IconCopy size={14} />
      </button>
      {hasOutputBody ? (
        <button
          type="button"
          className="term-warp-block__toolbar-btn"
          title="复制输出"
          aria-label="复制输出"
          onClick={() => copyBlockText(output || block.output, "已复制输出")}
        >
          <IconClipboard size={14} />
        </button>
      ) : null}
      <button
        type="button"
        className="term-warp-block__toolbar-btn term-warp-block__toolbar-btn--danger"
        title={t("terminal.feed.deleteBlock")}
        aria-label={t("terminal.feed.deleteBlock")}
        onClick={() => void handleDelete()}
      >
        <IconClose size={14} />
      </button>
    </div>
  );
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

function AiBlockNavButtons({
  sessionId,
  blockId,
  aiBlockIds,
}: {
  sessionId: string;
  blockId: string;
  aiBlockIds: string[];
}) {
  const { t } = useI18n();

  if (!aiBlockIds || aiBlockIds.length <= 1) return null;

  const currentIndex = aiBlockIds.indexOf(blockId);
  if (currentIndex < 0) return null;

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < aiBlockIds.length - 1;

  const scrollTo = (targetId: string) => {
    scrollTerminalBlockIntoView(sessionId, targetId);
  };

  return (
    <div className="term-warp-ai-nav" role="group" aria-label={t("terminal.ai.navGroup")}>
      {hasPrev ? (
        <button
          type="button"
          className="term-warp-ai-nav__btn"
          aria-label={t("terminal.ai.navPrev")}
          title={t("terminal.ai.navPrev")}
          onClick={(event) => {
            event.stopPropagation();
            scrollTo(aiBlockIds[currentIndex - 1]!);
          }}
        >
          <span className="term-warp-ai-nav__triangle" aria-hidden />
        </button>
      ) : null}
      {hasNext ? (
        <button
          type="button"
          className="term-warp-ai-nav__btn"
          aria-label={t("terminal.ai.navNext")}
          title={t("terminal.ai.navNext")}
          onClick={(event) => {
            event.stopPropagation();
            scrollTo(aiBlockIds[currentIndex + 1]!);
          }}
        >
          <span className="term-warp-ai-nav__triangle term-warp-ai-nav__triangle--down" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function AiBlockHeaderActions({
  block,
  sessionId,
  expanded,
  onToggle,
  onFocusInput,
  aiBlockIds,
}: {
  block: TerminalBlock;
  sessionId: string;
  expanded: boolean;
  onToggle: () => void;
  onFocusInput?: () => void;
  aiBlockIds: string[];
}) {
  const { t } = useI18n();
  const removeBlock = useBlocksStore((s) => s.removeBlock);
  const setExpandedAiBlock = useTerminalUiStore((s) => s.setExpandedAiBlock);

  const handleDelete = async () => {
    const ok = await appConfirm(
      t("terminal.feed.deleteBlockConfirm"),
      t("terminal.feed.deleteBlock"),
      { kind: "warning", confirmLabel: t("terminal.feed.confirmAction") },
    );
    if (!ok) return;
    if (expanded) setExpandedAiBlock(sessionId, null);
    removeBlock(block.id);
    showToast(t("terminal.feed.deleteBlockDone"));
  };

  return (
    <div className="term-warp-block__header-actions">
      <AiBlockNavButtons sessionId={sessionId} blockId={block.id} aiBlockIds={aiBlockIds} />
      <BlockAttachToAiButton block={block} sessionId={sessionId} onFocusInput={onFocusInput} />
      <button
        type="button"
        className="term-warp-block__toolbar-btn term-warp-block__toolbar-btn--danger"
        title={t("terminal.feed.deleteBlock")}
        aria-label={t("terminal.feed.deleteBlock")}
        onClick={(event) => {
          event.stopPropagation();
          void handleDelete();
        }}
      >
        <IconClose size={14} />
      </button>
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
  searchHighlightQuery = "",
}: {
  block: TerminalBlock;
  expanded: boolean;
  onToggle: () => void;
  searchHighlightQuery?: string;
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
      <span className="term-warp-block__title">
        <FeedSearchHighlightText text={blockTitle(block)} query={searchHighlightQuery} />
      </span>
    </button>
  );
}

function AiStatusIcon({ block }: { block: TerminalBlock }) {
  if (block.status === "running") {
    return <span className="term-warp-block__status term-warp-block__status--running" aria-hidden />;
  }
  if (block.kind === "ai") {
    if (block.status === "failed") {
      return <span className="term-warp-block__status term-warp-block__status--failed">✕</span>;
    }
    return <span className="term-warp-block__status term-warp-block__status--ok">✓</span>;
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
  dockExpanded = false,
  stickyOnCard = true,
  feedPinnedToBottom,
  onFocusInput,
  aiBlockIds,
  searchFocused = false,
  searchHighlightQuery = "",
}: {
  blockId: string;
  sessionId: string;
  expanded: boolean;
  onToggle: () => void;
  /** 当前视口上下文中可吸顶的 AI 候选 */
  isStickyCandidate?: boolean;
  /** 展开 dock 布局（限高 + 内部滚动） */
  dockExpanded?: boolean;
  /** 是否在卡片上应用 position:sticky（anchor 吸顶时为 false） */
  stickyOnCard?: boolean;
  feedPinnedToBottom: boolean;
  onFocusInput?: () => void;
  aiBlockIds: string[];
  searchFocused?: boolean;
  searchHighlightQuery?: string;
}) {
  const block = useBlocksStore((state) => state.findBlockById(blockId));
  const dockMaxHeight = useTerminalUiStore(
    (state) => state.aiDockHeights[sessionId] ?? DEFAULT_AI_DOCK_HEIGHT,
  );

  const isDocked = dockExpanded || Boolean(isStickyCandidate && expanded);

  const dockAutoScroll = Boolean(
    block?.kind === "ai" &&
      isDocked &&
      feedPinnedToBottom &&
      block.status === "running",
  );

  if (!block || block.kind !== "ai") return null;

  const stickyClass =
    stickyOnCard && isStickyCandidate ? " term-warp-block--ai-sticky" : "";
  const dockClass = isDocked && expanded ? " term-warp-block--ai-sticky-docked" : "";
  const searchClass = searchFocused ? " term-warp-block--search-focus" : "";

  if (!expanded) {
    return (
      <article
        className={`term-warp-block term-warp-block--ai term-warp-block--collapsed${stickyClass}${searchClass}`}
        data-block-id={block.id}
      >
        <AiBlockSummary
          block={block}
          expanded={false}
          onToggle={onToggle}
          searchHighlightQuery={searchHighlightQuery}
        />
        <AiBlockHeaderActions
          block={block}
          sessionId={sessionId}
          expanded={false}
          onToggle={onToggle}
          onFocusInput={onFocusInput}
          aiBlockIds={aiBlockIds}
        />
      </article>
    );
  }

  return (
    <article
      className={`term-warp-block term-warp-block--ai term-warp-block--expanded${stickyClass}${dockClass}${searchClass}`}
      style={isDocked ? { maxHeight: dockMaxHeight } : undefined}
      data-block-id={block.id}
    >
      <header className="term-warp-block__header">
        <AiBlockSummary
          block={block}
          expanded
          onToggle={onToggle}
          searchHighlightQuery={searchHighlightQuery}
        />
        <span className="term-warp-block__badge">助手</span>
        <AiBlockHeaderActions
          block={block}
          sessionId={sessionId}
          expanded
          onToggle={onToggle}
          onFocusInput={onFocusInput}
          aiBlockIds={aiBlockIds}
        />
      </header>
      <TerminalAiThreadView
        blockId={block.id}
        sessionId={sessionId}
        dockedAutoScroll={dockAutoScroll}
      />
      <BlockCollapseFooter collapsed={false} onToggle={onToggle} variant="ai" />
      {isDocked ? <AiDockResizeHandle sessionId={sessionId} /> : null}
    </article>
  );
}

const MemoAiBlockCard = memo(AiBlockCard, (prev, next) =>
  prev.blockId === next.blockId &&
  prev.sessionId === next.sessionId &&
  prev.expanded === next.expanded &&
  prev.isStickyCandidate === next.isStickyCandidate &&
  prev.dockExpanded === next.dockExpanded &&
  prev.stickyOnCard === next.stickyOnCard &&
  prev.feedPinnedToBottom === next.feedPinnedToBottom &&
  prev.onFocusInput === next.onFocusInput &&
  prev.aiBlockIds === next.aiBlockIds &&
  prev.searchFocused === next.searchFocused &&
  prev.searchHighlightQuery === next.searchHighlightQuery,
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
  searchFocused = false,
  searchHighlightQuery = "",
}: {
  block: TerminalBlock;
  sessionId: string;
  resourceId?: string;
  promptSymbol?: string;
  onRunCommand?: (command: string) => void;
  sessionType?: TerminalSessionType;
  sessionUser?: string | null;
  onFocusInput?: () => void;
  searchFocused?: boolean;
  searchHighlightQuery?: string;
}) {
  const { t } = useI18n();
  // 稳定 output 引用：避免 useSftpEnrichedLsListing effect 频繁 cleanup 导致
  // SFTP fetch promise 反复被 cancelled（首次 cd 后 listing 已渲染但 SFTP 拉不到）
  const rawSource = useMemo(() => blockListingSource(block), [
    block.command,
    block.liveOutput,
    block.output,
  ]);
  const output = useMemo(
    () => shellOutput(block),
    [block.attachedListing, block.command, block.output, block.liveOutput, block.status],
  );
  const duration = formatDuration(block);
  const running = block.status === "running";
  const cmd = stripAutoLsSuffix(normalizeBlockCommand(block.command));
  const isError =
    block.status === "failed" ||
    (block.exitCode !== null && block.exitCode !== 0) ||
    hasShellErrorSignals(rawSource);

  const lsListing = useMemo(() => {
    if (block.attachedListing) {
      return block.attachedListing.entries.length > 0 ? block.attachedListing : null;
    }
    if (!rawSource.trim() || isError) return null;
    const parsed = tryParseLsListing(block.command, rawSource);
    if (!parsed || parsed.entries.length === 0) return null;
    return parsed;
  }, [block.attachedListing, block.command, rawSource, isError]);

  const listingCwd =
    resolveShellOutputCwd(block.output) ||
    resolveCdDestination(cmd, block.cwd, sessionUser) ||
    block.cwd;
  const directoryPreview = shouldUseDirectoryPreview(block);
  const showCommandLine = cmd.length > 0;
  const sshJumpTarget = block.linkedTabId?.trim() || null;

  const hasOutputBody =
    !!lsListing || (!!output && !directoryPreview) || !!sshJumpTarget;
  const [bodyCollapsed, setBodyCollapsed] = useState(false);
  const collapseNonce = useTerminalUiStore(
    (state) => state.shellBodyCollapseNonce[sessionId] ?? 0,
  );
  const sessionBodyCollapsed = useTerminalUiStore(
    (state) => state.shellBodyCollapsedBySession[sessionId],
  );
  useEffect(() => {
    if (typeof sessionBodyCollapsed !== "boolean") return;
    setBodyCollapsed(sessionBodyCollapsed);
  }, [collapseNonce, sessionBodyCollapsed]);

  const showEmptyHint =
    !running &&
    !hasOutputBody &&
    !bodyCollapsed &&
    (directoryPreview || showCommandLine);
  const emptyHintText = directoryPreview
    ? t("terminal.feed.emptyDirectory")
    : t("terminal.feed.emptyOutput");
  const outputLineCount = useMemo(() => {
    const text = lsListing ? output || block.output : output;
    if (!text) return 0;
    return text.replace(/\n+$/, "").split("\n").length;
  }, [lsListing, output, block.output]);

  const showCollapseControl = hasOutputBody || bodyCollapsed;

  return (
    <article
      className={`term-warp-block term-warp-block--shell${
        bodyCollapsed ? " term-warp-block--body-collapsed" : ""
      }${directoryPreview && !hasOutputBody ? " term-warp-block--dir-empty" : ""}${
        searchFocused ? " term-warp-block--search-focus" : ""
      }`}
      data-block-id={block.id}
    >
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
          <span className="term-warp-prompt-line__cmd">
            <FeedSearchHighlightText text={cmd} query={searchHighlightQuery} />
          </span>
          {duration ? <span className="term-warp-prompt-line__dur">{duration}</span> : null}
          {running ? <ShellBlockStopButton sessionId={sessionId} running /> : null}
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
      {!bodyCollapsed && lsListing ? (
        <EnrichedLsListingView
          listing={lsListing}
          command={block.attachedListing ? "ls" : block.command}
          cwd={listingCwd}
          sessionId={sessionId}
          sessionType={sessionType}
          sessionUser={sessionUser}
          resourceId={resourceId}
          rawOutput={rawSource}
          fallbackOutput={output}
          isError={isError}
          onRunCommand={onRunCommand}
          highlightQuery={searchHighlightQuery}
        />
      ) : !bodyCollapsed && sshJumpTarget ? (
        <button
          type="button"
          className="term-warp-ssh-jump"
          onClick={() => {
            if (!focusTerminalTab(sshJumpTarget)) {
              showToast(t("terminal.command.sshJumpTabMissing"));
            }
          }}
        >
          <span className="term-warp-ssh-jump__summary">
            {t("terminal.command.sshJumpBlockSummary", {
              name: block.linkedTabTitle ?? block.linkedTabId ?? "",
            })}
          </span>
          <span className="term-warp-ssh-jump__action">
            {t("terminal.command.sshJumpAction")}
          </span>
        </button>
      ) : !bodyCollapsed && output && !directoryPreview ? (
        <pre
          className={`term-warp-output${isError ? " term-warp-output--error" : ""}`}
        >
          <FeedSearchHighlightText text={output} query={searchHighlightQuery} />
        </pre>
      ) : showEmptyHint ? (
        <div className="term-warp-output-empty" aria-label={emptyHintText}>
          {emptyHintText}
        </div>
      ) : null}
      <BlockCollapseFooter
        collapsed={bodyCollapsed}
        onToggle={() => setBodyCollapsed((value) => !value)}
        lineCount={outputLineCount}
        showCollapse={showCollapseControl}
        actions={
          <ShellBlockToolbar
            block={block}
            sessionId={sessionId}
            cmd={cmd}
            output={output}
            hasOutputBody={hasOutputBody}
            onFocusInput={onFocusInput}
          />
        }
      />
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
  aiBlockIds,
  searchFocusedBlockId = null,
  searchHighlightQuery = "",
  useStickyAnchor = false,
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
  aiBlockIds: string[];
  searchFocusedBlockId?: string | null;
  searchHighlightQuery?: string;
  /** 展开吸顶 AI 作为 sticky-context 直接子级，避免 segment 过短导致吸顶失效 */
  useStickyAnchor?: boolean;
}) {
  const { ai, shells } = segment;
  const expanded = resolveAiExpanded(ai, expandedAiBlockId);
  const isStickyCandidate = ai.id === stickyAiBlockId;
  const shouldDock = expanded && isStickyCandidate;

  const onToggle = () => {
    if (expanded) {
      setExpandedAiBlock(sessionId, null);
    } else {
      setExpandedAiBlock(sessionId, ai.id);
    }
  };

  const aiCard = (
    <MemoAiBlockCard
      blockId={ai.id}
      sessionId={sessionId}
      expanded={expanded}
      onToggle={onToggle}
      isStickyCandidate={isStickyCandidate}
      dockExpanded={shouldDock}
      stickyOnCard={!useStickyAnchor}
      feedPinnedToBottom={feedPinnedToBottom}
      onFocusInput={onFocusInput}
      aiBlockIds={aiBlockIds}
      searchFocused={searchFocusedBlockId === ai.id}
      searchHighlightQuery={searchHighlightQuery}
    />
  );

  const shellCards = shells.map((shell) => (
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
      searchFocused={searchFocusedBlockId === shell.id}
      searchHighlightQuery={searchHighlightQuery}
    />
  ));

  if (useStickyAnchor && shouldDock) {
    return (
      <>
        <div className="term-warp-ai-sticky-anchor" data-block-id={ai.id}>
          {aiCard}
        </div>
        {shellCards}
      </>
    );
  }

  return (
    <div className="term-warp-sticky-segment" data-block-id={ai.id}>
      {aiCard}
      {shellCards}
    </div>
  );
}

type FeedSegmentViewProps = {
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
  aiBlockIds: string[];
  searchFocusedBlockId?: string | null;
  searchHighlightQuery?: string;
};

function renderFeedSegment(
  segment: ReturnType<typeof groupFeedBlocksIntoSegments>[number],
  props: FeedSegmentViewProps,
  options?: { useStickyAnchor?: boolean },
) {
  if (segment.kind === "orphan-shells") {
    return segment.blocks.map((block) => (
      <MemoShellBlockCard
        key={block.id}
        block={block}
        sessionId={props.sessionId}
        resourceId={props.resourceId}
        promptSymbol={props.promptSymbol}
        onRunCommand={props.onRunCommand}
        sessionType={props.sessionType}
        sessionUser={props.sessionUser}
        onFocusInput={props.onFocusInput}
        searchFocused={props.searchFocusedBlockId === block.id}
        searchHighlightQuery={props.searchHighlightQuery}
      />
    ));
  }

  return (
    <FeedAiRunSegmentView
      key={segment.ai.id}
      segment={segment}
      sessionId={props.sessionId}
      resourceId={props.resourceId}
      promptSymbol={props.promptSymbol}
      expandedAiBlockId={props.expandedAiBlockId}
      setExpandedAiBlock={props.setExpandedAiBlock}
      stickyAiBlockId={props.stickyAiBlockId}
      feedPinnedToBottom={props.feedPinnedToBottom}
      onRunCommand={props.onRunCommand}
      sessionType={props.sessionType}
      sessionUser={props.sessionUser}
      onFocusInput={props.onFocusInput}
      aiBlockIds={props.aiBlockIds}
      searchFocusedBlockId={props.searchFocusedBlockId}
      searchHighlightQuery={props.searchHighlightQuery}
      useStickyAnchor={options?.useStickyAnchor}
    />
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
  isActive = true,
}: TerminalBlockFeedProps) {
  const blocks = useBlocksStore((state) => state.blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS);
  const { t } = useI18n();
  const expandedAiBlockId = useTerminalUiStore((state) => state.expandedAiBlockIds[sessionId] ?? null);
  const setExpandedAiBlock = useTerminalUiStore((state) => state.setExpandedAiBlock);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevBlockCountRef = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFilters, setSearchFilters] = useState<FeedSearchFilters>(DEFAULT_FEED_SEARCH_FILTERS);
  const [searchFocusIndex, setSearchFocusIndex] = useState(0);
  /** 用户未主动上滚时持续跟随输出；内容增高后不能用即时 isFeedPinnedToBottom 判断 */
  const followOutputRef = useRef(true);
  const [feedPinnedToBottom, setFeedPinnedToBottom] = useState(true);
  const [feedCanScroll, setFeedCanScroll] = useState(false);
  const [feedAtTop, setFeedAtTop] = useState(true);
  const lastFeedScrollHeightRef = useRef(0);
  const prevActivitySignatureRef = useRef("");
  const prevShellSignatureRef = useRef("");
  const feedScrollRafRef = useRef(0);
  /** tab 隐藏前最后一次可见的 scrollTop —— display:none 会丢失滚动位置，切回时据此恢复 */
  const savedScrollTopRef = useRef(0);

  useTerminalCopyContextMenu(scrollRef);

  const renderableBlocks = useMemo(() => blocks.filter(shouldRenderBlock), [blocks]);
  const searchFiltering = searchOpen && isFeedSearchFiltering(searchFilters);
  const matchIds = useMemo(
    () => listFeedSearchMatchIds(blocks, searchFilters, shouldRenderBlock),
    [blocks, searchFilters],
  );

  useEffect(() => {
    setSearchFocusIndex(0);
  }, [searchFilters.query, searchFilters.kind, searchFilters.failedOnly]);

  const searchFocusedBlockId = useMemo(() => {
    if (!searchOpen || matchIds.length === 0) return null;
    if (!isFeedSearchFiltering(searchFilters) && searchFocusIndex === 0) return null;
    const index = Math.min(searchFocusIndex, matchIds.length - 1);
    return matchIds[index] ?? null;
  }, [matchIds, searchFilters, searchFocusIndex, searchOpen]);

  const searchHighlightQuery =
    searchOpen && searchFilters.query.trim() ? searchFilters.query.trim() : "";

  const visibleBlocks = useMemo(() => {
    if (!searchFiltering) return renderableBlocks;
    const idSet = new Set(matchIds);
    return renderableBlocks.filter((block) => idSet.has(block.id));
  }, [matchIds, renderableBlocks, searchFiltering]);

  const focusMatchAt = useCallback(
    (index: number) => {
      if (matchIds.length === 0) return;
      const clamped = ((index % matchIds.length) + matchIds.length) % matchIds.length;
      setSearchFocusIndex(clamped);
      const blockId = matchIds[clamped];
      if (blockId) scrollTerminalBlockIntoView(sessionId, blockId);
    },
    [matchIds, sessionId],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchFilters(DEFAULT_FEED_SEARCH_FILTERS);
    setSearchFocusIndex(0);
  }, []);

  const patchSearchFilters = useCallback((patch: Partial<FeedSearchFilters>) => {
    setSearchFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  useEffect(() => {
    if (!searchOpen || !searchFiltering || matchIds.length === 0) return;
    scrollTerminalBlockIntoView(sessionId, matchIds[0]!);
  }, [
    matchIds,
    searchFilters.failedOnly,
    searchFilters.kind,
    searchFilters.query,
    searchFiltering,
    searchOpen,
    sessionId,
  ]);

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive]);
  const aiBlockIds = useMemo(
    () =>
      renderableBlocks
        .filter((entry) => entry.kind === "ai")
        .map((entry) => entry.id),
    [renderableBlocks],
  );
  const feedSegments = useMemo(
    () => groupFeedBlocksIntoSegments(visibleBlocks),
    [visibleBlocks],
  );
  const expandedAiSegmentIndex = useMemo(
    () => findExpandedAiSegmentIndex(feedSegments, expandedAiBlockId),
    [feedSegments, expandedAiBlockId],
  );
  const activitySignature = useMemo(
    () => buildFeedActivitySignature(visibleBlocks),
    [visibleBlocks],
  );
  const shellSignature = useMemo(
    () => buildFeedShellSignature(visibleBlocks),
    [visibleBlocks],
  );
  const stickyAiBlockId = useStickyAiBlockId(
    scrollRef,
    listRef,
    visibleBlocks,
    shellSignature,
    expandedAiBlockId,
  );
  const segmentViewProps = useMemo<FeedSegmentViewProps>(
    () => ({
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
      aiBlockIds,
      searchFocusedBlockId,
      searchHighlightQuery,
    }),
    [
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
      aiBlockIds,
      searchFocusedBlockId,
      searchHighlightQuery,
    ],
  );

  // 重新测量并同步滚动条派生状态：pinned / canScroll / atTop。
  // 稳定引用，供 scroll 监听与 tab 切回可见时复用。
  // 注意：元素 display:none 时 clientHeight/scrollHeight/scrollTop 全为 0，
  // 此时不能 sync —— 否则会用 0 尺寸把 followOutputRef 误判为 false（isScrollPinnedToBottom
  // 会把 scrollHeight 突然变 0 当成"内容被清空"），并把 savedScrollTopRef 覆盖为 0。
  const syncFeedScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.clientHeight === 0) return; // 隐藏期间不测量
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
    // 保存当前位置 —— tab 切走变 display:none 时浏览器会丢失 scrollTop，
    // 切回后据此恢复用户阅读位置。
    savedScrollTopRef.current = el.scrollTop;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    syncFeedScrollState();
    el.addEventListener("scroll", syncFeedScrollState, { passive: true });
    window.addEventListener("resize", syncFeedScrollState);
    return () => {
      el.removeEventListener("scroll", syncFeedScrollState);
      window.removeEventListener("resize", syncFeedScrollState);
    };
  }, [visibleBlocks.length, syncFeedScrollState]);

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

  // dockview 默认 onlyWhenVisible：切走 tab 时 content 元素从 DOM 摘离（removeChild），
  // 切回时重新插入；React 组件不卸载，但浏览器会丢失 scrollTop。
  // 注意：isActive prop 不会变化——dockview 的 renderPanel 只在 panel 创建时调用一次，
  // 之后 tab 切换由 dockview 内部摘离/插入 DOM，不会重新调用 renderPanel。
  // 因此这里用 IntersectionObserver 直接检测容器可见性变化，不依赖 isActive prop。
  //  - 隐藏时 savedScrollTopRef 已保存最后可见的 scrollTop（见 syncFeedScrollState）
  //  - 恢复可见时：若 followOutputRef 为真（贴底/有新输出）跳最新，否则恢复保存的位置
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    wasVisibleRef.current = el.clientHeight > 0;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries[0].isIntersecting && entries[0].intersectionRatio > 0;
        if (!wasVisibleRef.current && visible) {
          // 从摘离态恢复可见：下一帧（布局完成后）再恢复滚动位置
          requestAnimationFrame(() => {
            const target = scrollRef.current;
            if (!target || target.clientHeight === 0) return;
            if (followOutputRef.current) {
              scrollFeedToLatest(target);
            } else {
              // 恢复用户上滚阅读的位置；clamp 到当前 scrollHeight 内
              const max = target.scrollHeight - target.clientHeight;
              target.scrollTop = Math.max(0, Math.min(savedScrollTopRef.current, max));
            }
            syncFeedScrollState();
          });
        }
        wasVisibleRef.current = visible;
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [syncFeedScrollState]);

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

  if (renderableBlocks.length === 0) return null;

  return (
    <div className={`term-warp-feed${searchOpen ? " term-warp-feed--search-open" : ""}`} ref={scrollRef}>
      {searchOpen ? (
        <FeedSearchBar
          filters={searchFilters}
          matchCount={matchIds.length}
          focusIndex={Math.min(searchFocusIndex, Math.max(matchIds.length - 1, 0))}
          onChange={patchSearchFilters}
          onPrev={() => focusMatchAt(searchFocusIndex - 1)}
          onNext={() => focusMatchAt(searchFocusIndex + 1)}
          onClose={closeSearch}
        />
      ) : null}
      <div className="term-warp-feed__list" ref={listRef}>
        {searchFiltering && visibleBlocks.length === 0 ? (
          <div className="term-feed-search__empty">{t("terminal.feed.search.noMatch")}</div>
        ) : null}
        {feedSegments.map((segment, index) => {
          if (expandedAiSegmentIndex >= 0) {
            if (index < expandedAiSegmentIndex) {
              return renderFeedSegment(segment, segmentViewProps);
            }
            if (index === expandedAiSegmentIndex) {
              return (
                <div
                  key={`sticky-ctx-${expandedAiBlockId}`}
                  className="term-warp-sticky-context"
                >
                  {feedSegments
                    .slice(expandedAiSegmentIndex)
                    .map((stickySegment, offset) =>
                      renderFeedSegment(stickySegment, segmentViewProps, {
                        useStickyAnchor: offset === 0,
                      }),
                    )}
                </div>
              );
            }
            return null;
          }

          return renderFeedSegment(segment, segmentViewProps);
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
