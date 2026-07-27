import {
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/reasoning";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/tool-group";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { MessageTiming } from "@/components/assistant-ui/message-timing";
import { ComposerContextUsage } from "@/components/assistant-ui/composer-context-usage";
import { AssistantStreamingHint } from "@/components/assistant-ui/streaming-hint";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import {
  ASSISTANT_PAGE_AGENT_ID,
  isAssistantPageAgentId,
} from "../../lib/ai/agents";
import { useAiStore } from "../../stores/aiStore";
import { AiConversationModelSelect } from "../ai/assistant-ui/AiConversationModelSelect";
import { AiConversationSkillSelect } from "../ai/assistant-ui/AiConversationSkillSelect";
import { AiAgentBadge } from "../ai/assistant-ui/AiAgentBadge";
import { AiContextStrip } from "../ai/AiContextStrip";
import { ComposerAddContextButton } from "../ai/assistant-ui/ComposerAddContextButton";
import { ComposerContextChips } from "../ai/assistant-ui/ComposerContextChips";
import { ComposerInputWithMention } from "../ai/assistant-ui/ComposerInputWithMention";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ListTodoIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
} from "react";
import { PlanView } from "../ai/PlanView";
import { SubConversationClusterCard } from "../ai/SubConversationClusterCard";
import { AiApprovalDock } from "../ai/AiApprovalDock";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import type {
  PlanData,
  SubConversationClusterPartData,
} from "../../lib/ai/aiMessageParts";
import {
  parseMarkdownChecklist,
  textFromMessageParts,
} from "../../lib/ai/parseMarkdownChecklist";
import {
  createTodoItem,
  nextTodoSortOrder,
  newTodoId,
  useKnowledgeTodoStore,
} from "../../stores/knowledgeTodoStore";
import { showToast } from "../../stores/toastStore";
export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/** 从 data part 提取 plan 数据；非 plan 返回 null */
function extractPlanFromDataPart(part: { type: string; data?: unknown }): PlanData | null {
  if (part.type !== "data" || !part.data) return null;
  const data = part.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "id" in data &&
    "steps" in data &&
    "title" in data
  ) {
    return data as PlanData;
  }
  return null;
}

/** 从 data part 提取子会话集群数据；非 cluster 返回 null */
function extractClusterFromDataPart(
  part: { type: string; data?: unknown },
): SubConversationClusterPartData | null {
  if (part.type !== "data" || !part.data) return null;
  const data = part.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "clusterId" in data &&
    "children" in data &&
    "toolCallId" in data
  ) {
    return data as SubConversationClusterPartData;
  }
  return null;
}

/**
 * Plan 吸顶浮层：对话流内 PlanView 滚出视口顶部时，显示一份吸顶副本。
 *
 * 设计（参考终端 AI 内嵌卡片吸顶）：
 * - 对话流内保留 PlanView 原始渲染（有消息上下文位置）
 * - 本组件在 Viewport 内顶部 sticky，用 scroll 事件监测对话流内 PlanView 位置
 * - PlanView 在视口内时本组件隐藏（opacity-0 + max-h-0）；滚出视口顶部时显示（吸顶）
 *
 * 实现要点：
 * - 始终渲染 sticky 容器（避免 display:none 切换导致 sticky 失效）
 * - 用 scroll 事件 + getBoundingClientRect 检测对话流内 PlanView（排除吸顶副本自身）
 * - 用 MutationObserver + setTimeout 应对 PlanView 延迟挂载
 * - 用 requestAnimationFrame 节流 scroll 回调
 */
const PlanStickyHeader: FC = () => {
  const viewingChildConversationId = useAiStore((s) => s.viewingChildConversationId);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const activeConv = useAiStore((s) =>
    s.conversations.find((c) => c.id === activeConversationId),
  );
  const plans = useAiOrchestrationStore((s) => s.plans);

  const planId = useMemo(() => {
    if (!activeConv) return null;
    const planIds: { id: string; updatedAt: number }[] = [];
    for (const msg of activeConv.messages) {
      const parts = msg.parts ?? [];
      for (const p of parts) {
        if (p.type === "plan") {
          planIds.push({ id: p.plan.id, updatedAt: p.plan.updatedAt });
        }
      }
    }
    if (planIds.length === 0) return null;
    planIds.sort((a, b) => b.updatedAt - a.updatedAt);
    return planIds[0].id;
  }, [activeConv]);

  const plan = planId ? plans[planId] : null;
  const [stuck, setStuck] = useState(false);
  const rafRef = useRef(0);
  const stickyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (viewingChildConversationId || !planId) {
      setStuck(false);
      return;
    }

    let scrollParent: Element | null = null;
    let mutationObserver: MutationObserver | null = null;
    let cleaned = false;
    let scrollHandler: (() => void) | null = null;

    // 查找对话流内的 PlanView（排除吸顶浮层自身）
    const findInlinePlanEl = (): Element | null => {
      if (!planId) return null;
      const all = document.querySelectorAll(`[data-plan-id="${CSS.escape(planId)}"]`);
      for (const el of all) {
        if (!el.closest('[data-slot="ai-plan-sticky-header"]')) {
          return el;
        }
      }
      return null;
    };

    const checkStuck = () => {
      const planEl = findInlinePlanEl();
      if (!planEl) return;
      const rect = planEl.getBoundingClientRect();
      // PlanView 顶部在视口顶部之上时（top < 0）触发吸顶
      setStuck(rect.top < 0);
    };

    const onScroll = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(checkStuck);
    };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (scrollParent && scrollHandler) {
        scrollParent.removeEventListener("scroll", scrollHandler);
      }
      if (mutationObserver) mutationObserver.disconnect();
    };

    // 查找滚动容器：优先用 data-slot，备选用 overflow 计算
    const findScrollParent = (): Element | null => {
      const viewport = document.querySelector('[data-slot="aui_thread-viewport"]');
      if (viewport) {
        const style = getComputedStyle(viewport);
        if (style.overflowY === "auto" || style.overflowY === "scroll") {
          return viewport;
        }
      }
      // 备选：从 stickyRef 向上找
      let node = stickyRef.current?.parentElement ?? null;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight
        ) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    };

    const attach = () => {
      if (cleaned) return;
      scrollParent = findScrollParent();
      if (!scrollParent) return;

      scrollHandler = onScroll;
      scrollParent.addEventListener("scroll", scrollHandler, { passive: true });
      checkStuck();

      // 监听 PlanView 延迟挂载
      mutationObserver = new MutationObserver(() => {
        if (findInlinePlanEl()) {
          checkStuck();
        }
      });
      mutationObserver.observe(scrollParent, { childList: true, subtree: true });
    };

    // 延迟一帧 + 重试，确保 DOM 已渲染
    const initTimer = setTimeout(attach, 200);
    // 再重试一次（应对长延迟挂载）
    const retryTimer = setTimeout(attach, 1000);

    return () => {
      clearTimeout(initTimer);
      clearTimeout(retryTimer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      cleanup();
    };
  }, [planId, viewingChildConversationId]);

  if (!planId || !plan || viewingChildConversationId) return null;

  return (
    <div
      ref={stickyRef}
      data-slot="ai-plan-sticky-header"
      className={cn(
        "sticky top-0 z-20 overflow-hidden transition-all duration-200",
        stuck
          ? "max-h-96 opacity-100 -mx-4 px-4 pt-2 pb-1 bg-background/95 backdrop-blur-sm border-b border-border"
          : "max-h-0 opacity-0 pointer-events-none",
      )}
    >
      <PlanView
        planId={planId}
        snapshot={plan}
        defaultCollapsed={false}
        showCancelRemaining
        onCancelRemaining={() => {
          const store = useAiOrchestrationStore.getState();
          for (const step of plan.steps) {
            if (step.status === "pending" || step.status === "in_progress") {
              store.updatePlanStep(planId, step.id, {
                status: "skipped",
                summary: "用户取消剩余步骤",
              });
            }
          }
          store.updatePlan(planId, { status: "cancelled" });
        }}
      />
    </div>
  );
};

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

export const Thread: FC<ThreadProps> = ({ components = EMPTY_COMPONENTS }) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean }> = ({ isEmpty }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        // 对齐模块面板：小圆角、紧凑内边距
        ["--composer-radius" as string]: "4px",
        ["--composer-padding" as string]: "6px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>

          {/* Plan 吸顶浮层：对话流内 PlanView 滚出视口时显示 */}
          <PlanStickyHeader />

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-1.5 overflow-visible pb-3 pt-1 md:pb-4",
              !isEmpty && "sticky bottom-0 mt-auto",
            )}
          >
            <ThreadScrollToBottom />
            <AiApprovalDock />
            <Composer />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const ThreadScrollToBottom: FC = () => {
  const { t } = useI18n();
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip={t("ai.composer.buttonScrollToBottom")}
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-md p-2 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const WELCOME_SUGGESTION_KEYS = [
  "weeklyOps",
  "envInstall",
  "incident",
  "release",
] as const;

const ThreadWelcome: FC = () => {
  const { t } = useI18n();
  const assistantMode = useAiStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeConversationId);
    const id = conv?.agentId ?? ASSISTANT_PAGE_AGENT_ID;
    return isAssistantPageAgentId(id) ? id : ASSISTANT_PAGE_AGENT_ID;
  });
  const title =
    assistantMode === "run" ? t("ai.welcome.titleRun") : t("ai.welcome.titlePlan");
  const subtitle =
    assistantMode === "run"
      ? t("ai.welcome.subtitleRun")
      : t("ai.welcome.subtitlePlan");
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center gap-3 px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-semibold duration-200">
        {title}
      </h1>
      <p className="aui-thread-welcome-subtitle text-muted-foreground fade-in slide-in-from-bottom-1 animate-in fill-mode-both max-w-md text-sm leading-relaxed duration-200">
        {subtitle}
      </p>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      {WELCOME_SUGGESTION_KEYS.map((key) => (
        <WelcomeSuggestionChip key={key} suggestionKey={key} />
      ))}
    </div>
  );
};

const WelcomeSuggestionChip: FC<{
  suggestionKey: (typeof WELCOME_SUGGESTION_KEYS)[number];
}> = ({ suggestionKey }) => {
  const { t } = useI18n();
  const aui = useAui();
  const title = t(`ai.welcome.suggestions.${suggestionKey}.title`);
  const prompt = t(`ai.welcome.suggestions.${suggestionKey}.prompt`);

  const onClick = useCallback(() => {
    aui.composer().setText(prompt);
    void aui.composer().send();
  }, [aui, prompt]);

  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <Button
        type="button"
        variant="ghost"
        onClick={onClick}
        className="aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border h-auto gap-1.5 rounded-md border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors"
      >
        {title}
      </Button>
    </div>
  );
};

const SaveAsTodoButton: FC = () => {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const content = useAuiState((s) => s.message.content);
  const running = useAuiState((s) => s.message.status?.type === "running");

  const onSave = useCallback(async () => {
    if (busy || running) return;
    const text = textFromMessageParts(content);
    const parsed = parseMarkdownChecklist(text, t("knowledge.todos.untitled"));
    if (!parsed) {
      showToast(t("ai.saveTodo.empty"));
      return;
    }
    setBusy(true);
    try {
      const store = useKnowledgeTodoStore.getState();
      if (store.lists.length === 0) {
        await store.loadLists();
      }
      const now = Date.now();
      const ok = await store.saveList({
        id: newTodoId(),
        title: parsed.title,
        description: "",
        items: parsed.items.map((item) =>
          createTodoItem({
            name: item.text,
            executor: "",
            description: item.text,
            done: item.done,
          }),
        ),
        sortOrder: nextTodoSortOrder(useKnowledgeTodoStore.getState().lists),
        createdAt: now,
        updatedAt: now,
      });
      showToast(ok ? t("ai.saveTodo.success") : t("ai.saveTodo.failed"));
    } finally {
      setBusy(false);
    }
  }, [busy, content, running, t]);

  return (
    <TooltipIconButton
      tooltip={t("ai.saveTodo.tooltip")}
      onClick={() => void onSave()}
      disabled={busy || running}
      aria-label={t("ai.saveTodo.button")}
    >
      <ListTodoIcon />
    </TooltipIconButton>
  );
};

const Composer: FC = () => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="border-border data-[dragging=true]:border-ring focus-within:border-[var(--accent)] flex w-full flex-col gap-1 rounded-(--composer-radius) border bg-bg p-(--composer-padding) transition-[border-color] focus-within:border-[var(--accent)] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-bg))] dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30"
        >
          <div className="aui-composer-context-row flex w-full min-w-0 flex-row flex-nowrap items-center gap-1.5 overflow-x-auto empty:hidden">
            <AiContextStrip variant="composer" />
            <ComposerContextChips />
          </div>
          <ComposerAttachments />
          <ComposerInputWithMention />
          <ComposerAction />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  const { t } = useI18n();
  const isGenerating = useAiStore((s) => s.isGenerating);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!isGenerating) {
      setStartedAt(null);
      setElapsedMs(0);
      return;
    }
    const start = performance.now();
    setStartedAt(start);
    setElapsedMs(0);
    const id = window.setInterval(() => {
      setElapsedMs(performance.now() - start);
    }, 100);
    return () => window.clearInterval(id);
  }, [isGenerating]);

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-1 min-w-0">
        <ComposerAddContextButton />
        <AiAgentBadge />
        <AiConversationModelSelect />
        <AiConversationSkillSelect />
      </div>
      <div className="flex items-center gap-1.5">
        <ComposerContextUsage />
        {isGenerating && startedAt != null ? (
          <span
            className="aui-composer-generating-elapsed text-muted-foreground hidden font-mono text-[11px] tabular-nums sm:inline"
            aria-live="polite"
          >
            {(elapsedMs / 1000).toFixed(1)}s
          </span>
        ) : null}
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip={t("ai.composer.buttonVoice")}
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate size-7 rounded-md"
                aria-label={t("ai.composer.buttonVoice")}
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip={t("ai.composer.buttonStopGenerating")}
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-md"
                aria-label={t("ai.composer.buttonStopGenerating")}
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip={t("ai.composer.buttonSend")}
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-[var(--r-sm)]"
              aria-label={t("ai.composer.buttonSend")}
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4.5" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-7 rounded-[var(--r-sm)]"
              aria-label={t("ai.composer.buttonStopGenerating")}
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const TerminalAssistantMessage: FC = () => {
  const { t } = useI18n();
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
  } = useContext(ThreadComponentsContext);

  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `-mb-7.5 min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-fg-2 px-2 leading-relaxed wrap-break-word [contain-intrinsic-size:auto_24px] [content-visibility:auto]"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return <ReasoningGroup group={part}>{children}</ReasoningGroup>;
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data": {
                const planData = extractPlanFromDataPart(part as { type: string; data?: unknown });
                if (planData) {
                  return <PlanView planId={planData.id} snapshot={planData} />;
                }
                const clusterData = extractClusterFromDataPart(part as { type: string; data?: unknown });
                if (clusterData) {
                  return (
                    <SubConversationClusterCard
                      clusterId={clusterData.clusterId}
                      defaultCollapsed={false}
                    />
                  );
                }
                return part.dataRendererUI;
              }
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label={t("ai.composer.assistantWorking")}
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <ActionBarPrimitive.Root
          hideWhenRunning
          autohide="not-last"
          className="aui-assistant-action-bar-root text-muted-foreground flex gap-1"
        >
          <ActionBarPrimitive.Copy asChild>
            <TooltipIconButton tooltip={t("ai.composer.buttonCopy")}>
              <CopyIcon />
            </TooltipIconButton>
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
};

const TerminalThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = TerminalAssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const { t } = useI18n();
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
  } = useContext(ThreadComponentsContext);

  // reserves space for action bar and compensates with `-mb` for consistent msg spacing
  // keeps hovered action bar from shifting layout (autohide doesn't support absolute positioning well)
  // for pt-[n] use -mb-[n + 6] & min-h-[n + 6] to preserve compensation
  const ACTION_BAR_PT = "pt-1.5";
  const ACTION_BAR_HEIGHT = `-mb-7.5 min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        // [contain-intrinsic-size:auto_24px] fixes issue #4104, don't change without checking for regressions
        className="text-fg-2 px-2 leading-relaxed wrap-break-word [contain-intrinsic-size:auto_24px] [content-visibility:auto]"
      >
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-chainOfThought", "group-reasoning"],
            "tool-call": ["group-chainOfThought", "group-tool"],
            "standalone-tool-call": [],
          })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data": {
                const planData = extractPlanFromDataPart(part as { type: string; data?: unknown });
                if (planData) {
                  return <PlanView planId={planData.id} snapshot={planData} />;
                }
                const clusterData = extractClusterFromDataPart(part as { type: string; data?: unknown });
                if (clusterData) {
                  return (
                    <SubConversationClusterCard
                      clusterId={clusterData.clusterId}
                      defaultCollapsed={false}
                    />
                  );
                }
                return part.dataRendererUI;
              }
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label={t("ai.composer.assistantWorking")}
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <AssistantStreamingHint />
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  const { t } = useI18n();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <SaveAsTodoButton />
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip={t("ai.composer.buttonCopy")}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip={t("ai.composer.buttonRefresh")}>
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <MessageTiming />
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip={t("ai.composer.buttonMore")}
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-[var(--z-subwindow-popover)] min-w-[8rem] overflow-hidden rounded-md border p-1 shadow-lg backdrop-blur-sm"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              {t("ai.composer.buttonExport")}
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_60px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer bg-muted text-foreground rounded-lg px-4 py-2 wrap-break-word empty:hidden">
          <MessagePrimitive.Parts />
        </div>
        <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 row-start-3 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  const { t } = useI18n();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton
          tooltip={t("ai.composer.buttonEdit")}
          className="aui-user-action-edit"
        >
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  const { t } = useI18n();
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-background shadow-sm dark:shadow-none">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-md px-3.5"
            >
              {t("ai.composer.buttonCancel")}
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 rounded-md px-3.5">
              {t("ai.composer.buttonUpdate")}
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};

/** 仅消息列表（无 Composer），供终端内嵌 AI 卡片使用 */
export const ThreadMessagesOnly: FC<ThreadProps> = ({ components = EMPTY_COMPONENTS }) => {
  const mergedComponents = useMemo<ThreadComponents>(
    () => ({
      ...components,
      AssistantMessage: components.AssistantMessage ?? TerminalAssistantMessage,
    }),
    [components],
  );

  return (
    <ThreadComponentsContext.Provider value={mergedComponents}>
      <ThreadPrimitive.Root
        className="aui-root aui-thread-root term-warp-ai-thread-root flex flex-col"
        style={{
          ["--thread-max-width" as string]: "100%",
        }}
      >
        <ThreadPrimitive.Viewport className="flex flex-col overflow-x-auto overflow-y-hidden px-1 py-1">
          <div className="aui_message-group flex flex-col gap-y-4 empty:hidden">
            <ThreadPrimitive.Messages>{() => <TerminalThreadMessage />}</ThreadPrimitive.Messages>
          </div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </ThreadComponentsContext.Provider>
  );
};
