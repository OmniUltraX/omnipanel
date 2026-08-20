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
import { useTerminalRunStateStore } from "./terminalRunStateStore";
import { TerminalAiThreadView } from "./TerminalAiThreadView";
import { getResolvedAiThread } from "./aiThreadBridge";
import { AiDockResizeHandle } from "./AiDockResizeHandle";
import { DEFAULT_AI_DOCK_HEIGHT } from "./terminalAiDock";
import { useStickyAiBlockId } from "./useStickyAiBlockId";
import { cancelInlineAiBlock } from "./warpInlineAi";
import { extractLatestPlanSnapshot } from "./terminalAiPlan";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import { TerminalAiPlanHoverBadge } from "./TerminalAiPlanHoverBadge";
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
                ? item.parts
                    .map((p) => {
                      if (p.type === "text" || p.type === "reasoning") {
                        return `${p.type}:${p.text.length}`;
                      }
                      if (p.type === "tool-call") {
                        return `tc:${p.id}:${p.status}`;
                      }
                      if (p.type === "plan") {
                        return `plan:${p.plan.id}:${p.plan.status}`;
                      }
                      if (p.type === "sub-conversation-cluster") {
                        return `scc:${p.clusterId}:${p.status}`;
                      }
                      return "part";
                    })
                    .join(",")
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

const FEED_SCROLL_PIN_THRESHOLD_PX = FOLLOW_OUTPUT_PIN_THRESHOLD_PX;

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

function ShellBlockStopButton({
  sessionId,
  blockId,
  running,
}: {
  sessionId: string;
  blockId: string;
  running: boolean;
}) {
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
        // 孤儿 running 块（无对应 PTY 进程）也要能结束转圈
        const existing = useBlocksStore.getState().findBlockById(blockId);
        if (existing?.status === "running") {
          useBlocksStore.getState().updateBlock(blockId, {
            status: "failed",
            exitCode: 130,
          });
        }
        useTerminalUiStore.getState().endCommandLive(sessionId);
        useTerminalRunStateStore.getState().returnToPrompt(sessionId);
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
  const planSnapshot = extractLatestPlanSnapshot(block);
  const planId = planSnapshot?.id ?? null;
  const livePlan = useAiOrchestrationStore((s) =>
    planId ? (s.plans[planId] ?? null) : null,
  );
  const plan = livePlan ?? planSnapshot;

  return (
    <div
      className={`term-warp-block__summary${expanded ? " term-warp-block__summary--open" : ""}`}
    >
      <button
        type="button"
        className="term-warp-block__summary-toggle"
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
      {plan && plan.steps.length > 0 ? (
        <TerminalAiPlanHoverBadge blockId={block.id} plan={plan} />
      ) : null}
    </div>
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
          {running ? (
            <ShellBlockStopButton sessionId={sessionId} blockId={block.id} running />
          ) : null}
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
    const onSearch = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; action?: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      if (detail.action === "open") {
        setSearchOpen(true);
      }
    };
    window.addEventListener("omnipanel-terminal-search", onSearch);
    return () => window.removeEventListener("omnipanel-terminal-search", onSearch);
  }, [isActive, sessionId]);
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

  // 程序触发滚动时间戳：在该时间之前的 scroll 事件视为程序触发，不更新 followOutputRef
  const programmaticScrollUntilRef = useRef(0);

  // 统一的滚动到底部调度器
  const scheduleScrollToEndRef = useRef<(force?: boolean) => void>(() => {});

  // 更新派生 UI 状态（canScroll/atTop/savedScrollTop）
  const updateScrollUiState = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.clientHeight === 0) return;
    const scrollHeight = el.scrollHeight;
    const canScroll = scrollHeight - el.clientHeight > 1;
    setFeedCanScroll((prev) => (prev === canScroll ? prev : canScroll));
    const atTop = el.scrollTop <= 1;
    setFeedAtTop((prev) => (prev === atTop ? prev : atTop));
    savedScrollTopRef.current = el.scrollTop;
  }, []);

  // 同步 followRef（仅在用户主动滚动时调用）
  const syncFollowState = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.clientHeight === 0) return;
    // 程序触发的滚动不更新 followRef
    if (performance.now() < programmaticScrollUntilRef.current) return;
    const scrollHeight = el.scrollHeight;
    const pinned = isScrollPinnedToBottom(
      el,
      FEED_SCROLL_PIN_THRESHOLD_PX,
      lastFeedScrollHeightRef.current,
    );
    lastFeedScrollHeightRef.current = scrollHeight;
    followOutputRef.current = pinned;
    setFeedPinnedToBottom((prev) => (prev === pinned ? prev : pinned));
  }, []);

  // 立即滚到底
  const doScrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    if (Math.abs(el.scrollTop - max) <= 2) {
      updateScrollUiState();
      lastFeedScrollHeightRef.current = el.scrollHeight;
      return;
    }
    // 设置时间窗口：150ms 内的 scroll 事件都视为程序触发
    programmaticScrollUntilRef.current = performance.now() + 150;
    el.scrollTop = el.scrollHeight;
    lastFeedScrollHeightRef.current = el.scrollHeight;
    updateScrollUiState();
  }, [updateScrollUiState]);

  const markProgrammaticSmoothScroll = useCallback((distancePx: number) => {
    const durationMs = Math.min(900, Math.max(180, distancePx * 0.35));
    programmaticScrollUntilRef.current = performance.now() + durationMs + 80;
  }, []);

  const scrollFeedSmoothly = useCallback(
    (top: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const target = Math.max(0, Math.min(top, max));
      const distance = Math.abs(el.scrollTop - target);
      if (distance <= 2) {
        updateScrollUiState();
        return;
      }
      markProgrammaticSmoothScroll(distance);
      const behavior =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth";
      el.scrollTo({ top: target, behavior });
      lastFeedScrollHeightRef.current = el.scrollHeight;
    },
    [markProgrammaticSmoothScroll, updateScrollUiState],
  );

  // scroll 事件处理：只更新派生状态 + 在用户主动滚动时更新 followRef
  const handleScroll = useCallback(() => {
    updateScrollUiState();
    syncFollowState();
  }, [updateScrollUiState, syncFollowState]);

  // 绑定 scroll/resize 监听（仅挂载时绑定一次，不随块数变化重绑）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 初始同步一次状态
    updateScrollUiState();
    el.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll);
    return () => {
      el.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
    };
  }, [handleScroll, updateScrollUiState]);

  // 初始化统一滚动调度器：单 rAF 即可——useLayoutEffect 在 DOM commit 后、layout 前执行，
  // ResizeObserver 在 layout 后触发；rAF 在 layout+paint 前执行，此时 scrollHeight 已准确。
  useLayoutEffect(() => {
    let rafId = 0;
    let forceScroll = false;

    const performScroll = () => {
      rafId = 0;
      if (followOutputRef.current || forceScroll) {
        doScrollToEnd();
      }
      forceScroll = false;
    };

    scheduleScrollToEndRef.current = (force = false) => {
      if (force) forceScroll = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(performScroll);
    };

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      scheduleScrollToEndRef.current = () => {};
    };
  }, [doScrollToEnd]);

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

    if (blockCountGrew) {
      // 新块出现：强制跟随到底
      followOutputRef.current = true;
      setFeedPinnedToBottom(true);
      scheduleScrollToEndRef.current(true);
      return;
    }

    if (!followOutputRef.current) return;

    scheduleScrollToEndRef.current(false);
  }, [activitySignature, shellSignature, visibleBlocks.length]);

  // dockview 切 tab 恢复可见时的滚动位置恢复
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    wasVisibleRef.current = el.clientHeight > 0;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries[0].isIntersecting && entries[0].intersectionRatio > 0;
        if (!wasVisibleRef.current && visible) {
          requestAnimationFrame(() => {
            const target = scrollRef.current;
            if (!target || target.clientHeight === 0) return;
            if (followOutputRef.current) {
              doScrollToEnd();
            } else {
              const max = target.scrollHeight - target.clientHeight;
              programmaticScrollUntilRef.current = performance.now() + 150;
              target.scrollTop = Math.max(0, Math.min(savedScrollTopRef.current, max));
              updateScrollUiState();
            }
          });
        }
        wasVisibleRef.current = visible;
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [doScrollToEnd, updateScrollUiState]);

  // 首次挂载强制滚到底
  const didMountRef = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (didMountRef.current) return;
    didMountRef.current = true;
    requestAnimationFrame(() => {
      const target = scrollRef.current;
      if (!target) return;
      followOutputRef.current = true;
      setFeedPinnedToBottom(true);
      programmaticScrollUntilRef.current = performance.now() + 150;
      target.scrollTop = target.scrollHeight;
      updateScrollUiState();
    });
  }, [updateScrollUiState]);

  const scrollFeedToTop = useCallback(() => {
    followOutputRef.current = false;
    setFeedPinnedToBottom(false);
    scrollFeedSmoothly(0);
  }, [scrollFeedSmoothly]);

  const scrollFeedToBottomNow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    followOutputRef.current = true;
    setFeedPinnedToBottom(true);
    scrollFeedSmoothly(el.scrollHeight);
  }, [scrollFeedSmoothly]);

  // MutationObserver + ResizeObserver 双重保险：
  // - ResizeObserver 捕获元素尺寸变化（最常见的内容增长场景）
  // - MutationObserver 捕获 DOM 结构变化（节点新增、文本变化），在某些边缘情况下比 ResizeObserver 更快
  useEffect(() => {
    const list = listRef.current;
    const container = scrollRef.current;
    if (!list || !container) return;

    const scheduleIfFollowing = () => {
      updateScrollUiState();
      if (!followOutputRef.current) return;
      if (container.querySelector(".term-warp-block--ai-sticky-docked")) return;
      scheduleScrollToEndRef.current(false);
    };

    const resizeObserver = new ResizeObserver(() => {
      scheduleIfFollowing();
    });
    resizeObserver.observe(list);

    const mutationObserver = new MutationObserver(() => {
      scheduleIfFollowing();
    });
    mutationObserver.observe(list, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [updateScrollUiState]);

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
