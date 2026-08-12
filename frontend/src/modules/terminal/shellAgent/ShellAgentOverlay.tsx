import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import { UserQuestionForm } from "../../../components/ai/UserQuestionForm";
import type { UserQuestionFormData } from "../../../lib/ai/aiMessageParts";
import {
  EMPTY_TERMINAL_BLOCKS,
  isAiThreadMessage,
  isAiThreadToolCall,
  useBlocksStore,
  type AiThreadToolCall,
} from "../../../stores/blocksStore";
import { getResolvedAiThread } from "../aiThreadBridge";
import {
  approveInlineTerminalTool,
  rejectInlineTerminalTool,
} from "../inlineToolBridge";
import { isInlineTerminalToolName } from "../inlineTerminalTool";
import { getXterm } from "../xtermRegistry";
import {
  cancelShellAgent,
  newShellAgentSession,
  onShellAgentCardFitStable,
} from "./loop";
import {
  fitShellAgentCardToContent,
  getShellAgentGeometry,
  relayoutShellAgentCard,
  shieldShellAgentDecorationPointer,
  subscribeShellAgentGeometry,
  SHELL_AGENT_PORTAL_HOST_CLASS,
} from "./shellAgentGeometry";
import { hasDomTextSelection } from "../terminalTextSelection";
import { useShellAgentStore } from "./shellAgentStore";
import { ShellAgentMarkdown } from "./ShellAgentMarkdown";
import {
  getShellAgentLastCmd,
  getShellAgentThinkingFull,
  lastThinkingLine,
  setShellAgentLastCmd,
  setShellAgentThinkingFull,
} from "./thinkingCache";

function findAskFormInThread(
  thread: ReturnType<typeof getResolvedAiThread>,
  formId: string | null,
): UserQuestionFormData | null {
  if (!formId) return null;
  for (const item of thread) {
    if (!isAiThreadMessage(item)) continue;
    for (const part of item.parts ?? []) {
      if (part.type === "user-question" && part.form.formId === formId) {
        return part.form;
      }
    }
  }
  // fallback：最近一条 pending
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const item = thread[i]!;
    if (!isAiThreadMessage(item)) continue;
    for (const part of item.parts ?? []) {
      if (part.type === "user-question" && part.form.status === "pending") {
        return part.form;
      }
    }
  }
  return null;
}

type ShellAgentOverlayProps = {
  sessionId: string;
  promptSymbol?: string;
};

/** 仅思考 / 工具长内容用浮窗；锚定在展开按钮旁，非右下角 */
type FloatAnchor = {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
};

type DetailFloat =
  | { kind: "thinking"; anchor: FloatAnchor; fullText?: string }
  | {
      kind: "tool";
      toolId: string;
      anchor: FloatAnchor;
      /** 冻结确认卡等无 thread 项时的命令兜底 */
      commandFallback?: string;
    }
  | null;

function readAnchorRect(el: Element | null): FloatAnchor {
  const r = el?.getBoundingClientRect();
  if (!r) {
    return {
      top: 80,
      left: 24,
      bottom: 120,
      right: 320,
      width: 296,
    };
  }
  return {
    top: r.top,
    left: r.left,
    bottom: r.bottom,
    right: r.right,
    width: r.width,
  };
}

/** 同一锚点再点一次则关闭，否则打开/切换 */
function toggleDetailFloat(
  prev: DetailFloat,
  next: NonNullable<DetailFloat>,
): DetailFloat {
  if (!prev) return next;
  if (prev.kind !== next.kind) return next;
  if (prev.kind === "thinking" && next.kind === "thinking") return null;
  if (
    prev.kind === "tool" &&
    next.kind === "tool" &&
    prev.toolId === next.toolId
  ) {
    return null;
  }
  return next;
}

/**
 * 当前轮工具条：只显示 running，或 lastCmd 对应的那一条。
 * 切勿把 thread 里全部历史工具塞进同一 decoration，否则归档后堆叠遮挡。
 */
function resolveStripTools(toolCalls: AiThreadToolCall[], sessionId: string): AiThreadToolCall[] {
  const eligible = toolCalls.filter(
    (tc) => tc.status !== "pending" && tc.status !== "rejected",
  );
  const running = eligible.filter((tc) => tc.status === "running");
  if (running.length > 0) return running;
  const lastId = getShellAgentLastCmd(sessionId)?.toolId ?? null;
  if (lastId) {
    const match = eligible.find((tc) => tc.id === lastId);
    if (match) return [match];
  }
  const last = eligible[eligible.length - 1];
  return last ? [last] : [];
}

/** 浮窗贴在锚点下方，必要时翻到上方，并夹在视口内 */
function floatStyleFromAnchor(anchor: FloatAnchor): CSSProperties {
  const gap = 6;
  const maxW = Math.min(440, window.innerWidth - 16);
  const maxH = Math.min(window.innerHeight * 0.5, 420);
  let left = anchor.left;
  if (left + maxW > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - 8 - maxW);
  }
  left = Math.max(8, left);

  const spaceBelow = window.innerHeight - anchor.bottom - gap - 8;
  const placeAbove = spaceBelow < 160 && anchor.top > spaceBelow;
  if (placeAbove) {
    return {
      position: "fixed",
      left,
      bottom: window.innerHeight - anchor.top + gap,
      width: Math.max(anchor.width, Math.min(maxW, 360)),
      maxWidth: maxW,
      maxHeight: Math.min(maxH, anchor.top - gap - 8),
      zIndex: 45,
    };
  }
  return {
    position: "fixed",
    left,
    top: anchor.bottom + gap,
    width: Math.max(anchor.width, Math.min(maxW, 360)),
    maxWidth: maxW,
    maxHeight: Math.min(maxH, spaceBelow),
    zIndex: 45,
  };
}

function syncShellAgentThemeVars(el: HTMLElement): void {
  const cs = getComputedStyle(document.documentElement);
  const keys = [
    "--bg",
    "--bg-deeper",
    "--surface",
    "--surface-hover",
    "--fg",
    "--fg-2",
    "--muted",
    "--meta",
    "--border",
    "--border-soft",
    "--accent",
    "--accent-hover",
    "--accent-soft",
    "--accent-fg",
    "--success",
    "--warn",
    "--danger",
    "--danger-soft",
    "--font-mono",
    "--r-sm",
    "--motion-fast",
  ];
  for (const key of keys) {
    const value = cs.getPropertyValue(key).trim();
    if (value) el.style.setProperty(key, value);
  }
}

function ensurePortalHost(
  decoEl: HTMLElement,
  opts?: { grow?: boolean; scrollable?: boolean },
): HTMLElement {
  let host = decoEl.querySelector(
    `:scope > .${SHELL_AGENT_PORTAL_HOST_CLASS}`,
  ) as HTMLElement | null;
  if (!host) {
    host = document.createElement("div");
    host.className = SHELL_AGENT_PORTAL_HOST_CLASS;
    decoEl.replaceChildren(host);
  }
  const grow = Boolean(opts?.grow);
  const scrollable = Boolean(opts?.scrollable);
  // xterm decoration 有时不继承 html 主题变量，显式同步避免深色主题下白底
  syncShellAgentThemeVars(decoEl);
  syncShellAgentThemeVars(host);
  host.style.pointerEvents = "auto";
  host.style.boxSizing = "border-box";
  host.style.width = "100%";
  host.style.minHeight = "0";
  host.style.textAlign = "left";
  host.style.display = "flex";
  host.style.flexDirection = "column";
  host.style.justifyContent = "flex-start";
  host.style.alignItems = "flex-start";
  host.style.padding = "0";
  host.style.margin = "0";
  // final 结果卡需随内容增高；ask 卡触顶后卡内滚动；其它矮卡锁在 decoration 高度内
  if (grow) {
    host.style.height = "auto";
    host.style.maxHeight = "none";
    host.style.overflow = "visible";
    host.onwheel = null;
  } else if (scrollable) {
    host.style.height = "100%";
    host.style.maxHeight = "100%";
    host.style.overflowX = "hidden";
    host.style.overflowY = "auto";
    host.style.overscrollBehavior = "contain";
    host.onwheel = (e) => {
      e.stopPropagation();
    };
  } else {
    host.style.height = "100%";
    host.style.maxHeight = "100%";
    host.style.overflow = "hidden";
    host.onwheel = null;
  }
  return host;
}

function resolveToolCommand(item: AiThreadToolCall): string {
  const direct = item.command?.trim();
  if (direct) return direct;
  try {
    const parsed = JSON.parse(item.args) as { command?: string };
    if (typeof parsed.command === "string") return parsed.command.trim();
  } catch {
    // ignore
  }
  return "";
}

function shortAssistantNote(text: string, max = 480): string {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("```") && !l.startsWith("#"))
    .slice(0, 8)
    .join(" ")
    .slice(0, max);
}

function isDangerRisk(level: AiThreadToolCall["riskLevel"] | undefined): boolean {
  return level === "high" || level === "critical";
}

function measureShellAgentCardHeight(container: HTMLElement): number {
  const parts = container.querySelectorAll<HTMLElement>(
    ".term-shell-agent-card, .term-shell-agent-tool",
  );
  if (parts.length === 0) {
    // 用布局高度，避免 scrollHeight 被撑满后反馈放大
    return Math.ceil(container.getBoundingClientRect().height);
  }
  let total = 0;
  for (const el of parts) {
    total += el.getBoundingClientRect().height;
  }
  // 卡片间距
  if (parts.length > 1) total += (parts.length - 1) * 4;
  return Math.ceil(total);
}

function toolStatusLabel(
  status: AiThreadToolCall["status"],
  t: (key: string) => string,
): string {
  switch (status) {
    case "pending":
      return t("terminal.shellAgent.awaitingApproval");
    case "running":
      return t("terminal.shellAgent.executing");
    case "completed":
      return t("terminal.shellAgent.agreed");
    case "rejected":
      return t("terminal.shellAgent.rejected");
    case "failed":
      return t("terminal.shellAgent.failed");
    default:
      return status;
  }
}

/**
 * 直通 Shell Agent：流内 xterm decoration + portal；
 * 正文紧凑预览，完整思考/工具/解读点开弹窗查看。
 */
export function ShellAgentOverlay({ sessionId }: ShellAgentOverlayProps) {
  const { t } = useI18n();
  const agent = useShellAgentStore((s) => s.bySession[sessionId] ?? null);
  const blocks = useBlocksStore((s) => s.blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS);
  const [geoVersion, setGeoVersion] = useState(0);
  const [decoEl, setDecoEl] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [detail, setDetail] = useState<DetailFloat>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const floatRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return subscribeShellAgentGeometry((sid) => {
      if (sid === sessionId) setGeoVersion((v) => v + 1);
    });
  }, [sessionId]);

  const geometry = useMemo(
    () => getShellAgentGeometry(sessionId),
    // geoVersion 驱动重读
    [sessionId, geoVersion],
  );

  useLayoutEffect(() => {
    const deco = geometry?.decoration ?? null;
    const inline =
      Boolean(deco) && geometry?.mode === "inline" && Boolean(geometry?.cardKind);
    const isFinal = geometry?.cardKind === "final";
    const isAsk = geometry?.cardKind === "ask";
    // ask：卡内滚动；final：随内容 grow，避免占位高于内容留下大块空白
    const grow = isFinal;
    const scrollable = isAsk;

    if (!inline || !deco) {
      setDecoEl(null);
      return;
    }

    let cancelled = false;
    let renderDisposable: { dispose: () => void } | null = null;

    const attach = (el: HTMLElement) => {
      if (cancelled) return;
      el.style.pointerEvents = "auto";
      el.style.boxSizing = "border-box";
      el.style.display = "flex";
      el.style.flexDirection = "column";
      el.style.justifyContent = "flex-start";
      el.style.alignItems = "flex-start";
      el.style.padding = "0";
      el.style.margin = "0";
      if (grow) {
        el.style.height = "auto";
        el.style.minHeight = "0";
        el.style.maxHeight = "none";
        el.style.overflow = "visible";
      } else {
        el.style.height = "100%";
        el.style.minHeight = "0";
        el.style.maxHeight = "100%";
        el.style.overflow = "hidden";
      }
      shieldShellAgentDecorationPointer(el, getXterm(sessionId));
      setDecoEl(ensurePortalHost(el, { grow, scrollable }));
    };

    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      if (deco.element) {
        attach(deco.element);
        return;
      }
      renderDisposable = deco.onRender(attach);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      renderDisposable?.dispose();
    };
  }, [geometry?.decoration, geometry?.version, geometry?.mode, geometry?.cardKind, sessionId]);

  // 历史冻结卡也可能没有 pointer shield（热更新 / 旧快照）；按会话扫一遍补上
  useEffect(() => {
    const term = getXterm(sessionId);
    const root = term?.element;
    if (!root) return;
    root.querySelectorAll(".term-shell-agent-deco-card").forEach((node) => {
      if (node instanceof HTMLElement) {
        shieldShellAgentDecorationPointer(node, term);
      }
    });
  }, [sessionId, geoVersion]);

  useEffect(() => {
    const term = getXterm(sessionId);
    if (!term) return;
    const disposable = term.onResize(() => relayoutShellAgentCard(sessionId));
    return () => disposable.dispose();
  }, [sessionId]);

  const blockId = useMemo(() => {
    if (!agent || agent.phase === "cancelled") return null;
    if (!agent.blockId) return null;
    const hit = blocks.find((b) => b.id === agent.blockId && b.kind === "ai");
    return hit?.id ?? null;
  }, [agent, blocks]);

  const thread = useMemo(() => {
    if (!blockId) return [];
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return [];
    return getResolvedAiThread(block);
  }, [blockId, blocks]);

  const toolCalls = useMemo(
    () =>
      thread.filter(
        (i): i is AiThreadToolCall =>
          isAiThreadToolCall(i) && isInlineTerminalToolName(i.toolName),
      ),
    [thread],
  );

  const phase = agent?.phase ?? "idle";

  const latestAssistant = useMemo(() => {
    const texts = thread
      .filter(isAiThreadMessage)
      .filter((m) => m.role === "assistant")
      .map((m) => m.content.trim())
      .filter(Boolean);
    return texts[texts.length - 1] ?? "";
  }, [thread]);

  const latestReasoning = useMemo(() => {
    const texts = thread
      .filter(isAiThreadMessage)
      .filter((m) => m.role === "assistant")
      .map((m) => (m.reasoning ?? "").trim())
      .filter(Boolean);
    return texts[texts.length - 1] ?? "";
  }, [thread]);

  /** 思考预览：流式只刷最后一行；结束后显示「思考完成」 */
  const thinkingPreviewLine = useMemo(() => {
    const src = latestReasoning || latestAssistant;
    return lastThinkingLine(src);
  }, [latestReasoning, latestAssistant]);

  const thinkingFull = useMemo(() => {
    const parts: string[] = [];
    if (latestReasoning) parts.push(latestReasoning);
    if (latestAssistant) parts.push(latestAssistant);
    return parts.join("\n\n").trim();
  }, [latestReasoning, latestAssistant]);

  const pendingTool = toolCalls.find((tc) => tc.status === "pending") ?? null;
  const showFinal = geometry?.cardKind === "final";

  useEffect(() => {
    if (thinkingFull) setShellAgentThinkingFull(sessionId, thinkingFull);
  }, [sessionId, thinkingFull]);

  useEffect(() => {
    if (!pendingTool) return;
    setShellAgentLastCmd(sessionId, {
      command: resolveToolCommand(pendingTool),
      toolName: pendingTool.toolName,
      toolId: pendingTool.id,
      description: shortAssistantNote(latestAssistant, 280),
    });
  }, [
    sessionId,
    pendingTool?.id,
    pendingTool?.args,
    pendingTool?.command,
    latestAssistant,
  ]);

  // 冻结在 scrollback 的思考完成 / 已同意确认卡 / 工具条：委托点击展开
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      // 拖选正文后不要抢展开浮层；按钮 / 展开控件仍可点
      const isActionClick = Boolean(
        target.closest("button") ||
          target.closest("[data-shell-agent-expand]") ||
          target.closest(".term-shell-agent-btn"),
      );
      if (!isActionClick && hasDomTextSelection()) return;

      const thinkingCard = target.closest(
        `.term-shell-agent-card[data-shell-agent-frozen-thinking="1"][data-session-id="${sessionId}"]`,
      );
      if (thinkingCard) {
        e.preventDefault();
        e.stopPropagation();
        const full =
          thinkingCard.getAttribute("data-thinking-full") ||
          getShellAgentThinkingFull(sessionId);
        setDetail((prev) =>
          toggleDetailFloat(prev, {
            kind: "thinking",
            anchor: readAnchorRect(thinkingCard),
            fullText: full,
          }),
        );
        return;
      }

      const cmdCard = target.closest(
        `.term-shell-agent-card[data-shell-agent-frozen-cmd="1"][data-session-id="${sessionId}"]`,
      );
      if (cmdCard) {
        e.preventDefault();
        e.stopPropagation();
        const toolId = cmdCard.getAttribute("data-tool-id") || "";
        const command = cmdCard.getAttribute("data-tool-command") || "";
        setDetail((prev) =>
          toggleDetailFloat(prev, {
            kind: "tool",
            toolId: toolId || "__frozen_cmd__",
            anchor: readAnchorRect(cmdCard),
            commandFallback: command,
          }),
        );
        return;
      }

      const frozenTool = target.closest(
        `[data-shell-agent-frozen-tool="1"][data-session-id="${sessionId}"]`,
      );
      if (frozenTool) {
        e.preventDefault();
        e.stopPropagation();
        const toolId = frozenTool.getAttribute("data-tool-id") || "";
        if (!toolId) return;
        setDetail((prev) =>
          toggleDetailFloat(prev, {
            kind: "tool",
            toolId,
            anchor: readAnchorRect(frozenTool),
          }),
        );
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [sessionId]);

  const note = shortAssistantNote(latestAssistant, 280);
  /** 确认卡旁注跟流式正文，不做过短截断 */
  const pendingDesc = note;

  useEffect(() => {
    setEditing(false);
    setDraft(pendingTool ? resolveToolCommand(pendingTool) : "");
  }, [pendingTool?.id, pendingTool?.status]);

  // 方案 C：只渲染流内 decoration / 审批·询问 detached；禁止 sticky 兜底与「仅 busy」复活
  const hasThinkingGeo = geometry?.cardKind === "thinking";
  const detached = geometry?.mode === "detached";
  const hasLivePresentation =
    Boolean(geometry?.cardKind) ||
    Boolean(geometry?.decoration) ||
    (detached &&
      (phase === "awaiting_approval" ||
        phase === "awaiting_user_input" ||
        Boolean(pendingTool)));
  const showOverlay =
    Boolean(agent) && agent?.phase !== "cancelled" && hasLivePresentation;
  const portalHost = decoEl?.isConnected ? decoEl : null;
  const inlineActive = Boolean(
    geometry?.cardKind && portalHost && showOverlay && !detached,
  );
  const showDetachedFallback =
    detached &&
    showOverlay &&
    Boolean(
      pendingTool ||
        phase === "awaiting_approval" ||
        phase === "awaiting_user_input",
    );

  // 浮窗：点外部 / Esc / 终端滚动关闭（无模态遮罩，不挡终端操作）
  useEffect(() => {
    if (!detail) return;
    const onPointer = (e: PointerEvent) => {
      const el = floatRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      // 点在「展开」按钮上由按钮自己 toggle，此处忽略以免抢先关掉又被打开
      if (e.target instanceof Element && e.target.closest("[data-shell-agent-expand]")) {
        return;
      }
      // 冻结卡本体点击也走委托 toggle，勿在此抢关闭
      if (
        e.target instanceof Element &&
        (e.target.closest("[data-shell-agent-frozen-tool]") ||
          e.target.closest("[data-shell-agent-frozen-cmd]") ||
          e.target.closest("[data-shell-agent-frozen-thinking]"))
      ) {
        return;
      }
      setDetail(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetail(null);
    };
    const closeOnScroll = () => setDetail(null);
    const term = getXterm(sessionId);
    const scrollDisp = term?.onScroll(closeOnScroll);
    const viewport = term?.element?.querySelector(".xterm-viewport");
    viewport?.addEventListener("scroll", closeOnScroll, { passive: true });
    // 延后绑定，避免打开浮窗的同一次点击立刻关掉
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointer, true);
    }, 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
      scrollDisp?.dispose();
      viewport?.removeEventListener("scroll", closeOnScroll);
    };
  }, [detail, sessionId]);

  useLayoutEffect(() => {
    if (!inlineActive) return;

    const container = measureRef.current;
    if (!container) return;

    const isFinal = geometry?.cardKind === "final";
    const isThinking = geometry?.cardKind === "thinking";
    const measure = () => {
      const h = measureShellAgentCardHeight(container);
      if (h <= 0) return;
      // 思考卡固定矮高度；确认 / 工具 / 结果按内容撑开
      const capped = isThinking ? Math.min(h, 56) : h;
      fitShellAgentCardToContent(
        sessionId,
        capped,
        isFinal ? () => onShellAgentCardFitStable(sessionId) : undefined,
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    for (const el of container.querySelectorAll<HTMLElement>(
      ".term-shell-agent-card, .term-shell-agent-tool",
    )) {
      ro.observe(el);
    }
    return () => ro.disconnect();
  }, [
    inlineActive,
    sessionId,
    geometry?.cardKind,
    geometry?.version,
    phase,
    thinkingPreviewLine,
    latestAssistant,
    pendingDesc,
    pendingTool?.id,
    pendingTool?.status,
    toolCalls.length,
    editing,
    draft,
    agent?.pendingAskFormId,
    phase,
  ]);

  if (!agent || agent.phase === "cancelled") return null;
  if (!showOverlay) return null;

  const cardKind = geometry?.cardKind ?? null;
  const askForm = findAskFormInThread(thread, agent.pendingAskFormId);
  const showAskCard = cardKind === "ask" && Boolean(askForm);
  /** 待确认：独立确认卡（设计 nl-card pending） */
  const showConfirmCard =
    Boolean(pendingTool) && cardKind !== "final" && cardKind !== "ask" && Boolean(blockId);
  /** 当前轮工具条：勿把历史工具全堆进同一 decoration */
  const stripTools = resolveStripTools(toolCalls, sessionId);
  const showToolStrips =
    stripTools.length > 0 &&
    !showConfirmCard &&
    !showAskCard &&
    cardKind === "cmd";

  // 思考卡：仅流内 thinking 槽，不再 sticky 兜底
  const showThinking =
    !showFinal &&
    !showConfirmCard &&
    !showAskCard &&
    (cardKind === "thinking" || hasThinkingGeo);
  const thinkingVisible = showThinking;

  const danger = pendingTool ? isDangerRisk(pendingTool.riskLevel) : false;
  const confirmTool = pendingTool;

  const thinkingStreaming =
    thinkingVisible &&
    cardKind === "thinking" &&
    phase === "streaming" &&
    !showConfirmCard;
  const thinkingDone = thinkingVisible && !thinkingStreaming;

  const openThinkingDetail = (
    e?: { currentTarget: EventTarget | null },
  ) => {
    const raw =
      e?.currentTarget instanceof Element ? e.currentTarget : null;
    const el =
      raw?.closest?.(".term-shell-agent-card") ??
      raw ??
      document.querySelector(
        `.term-shell-agent-card--note[data-session-id="${sessionId}"]`,
      );
    setDetail((prev) =>
      toggleDetailFloat(prev, {
        kind: "thinking",
        anchor: readAnchorRect(el),
        fullText: thinkingFull || getShellAgentThinkingFull(sessionId),
      }),
    );
  };

  const thinkingCard = thinkingVisible ? (
    <div
      className={`term-shell-agent-card term-shell-agent-card--note is-fixed is-expandable${thinkingDone ? " is-done" : " is-thinking"}`}
      data-session-id={sessionId}
      role="button"
      tabIndex={0}
      data-shell-agent-expand
      onClick={(e) => openThinkingDetail(e)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openThinkingDetail(e);
        }
      }}
    >
      {thinkingStreaming ? (
        <span className="term-shell-agent-dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      ) : (
        <span className="term-shell-agent-ico term-shell-agent-ico--check" aria-hidden>
          ✓
        </span>
      )}
      <div className="term-shell-agent-card__note is-clamp is-oneline">
        {thinkingDone
          ? t("terminal.shellAgent.thinkingDone")
          : thinkingPreviewLine || t("terminal.shellAgent.thinking")}
      </div>
      <div className="term-shell-agent-card__note-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="term-shell-agent-btn term-shell-agent-btn--ghost"
          data-shell-agent-expand
          onClick={(e) => openThinkingDetail(e)}
        >
          {t("terminal.shellAgent.expand")}
        </button>
        {thinkingStreaming ? (
          <button
            type="button"
            className="term-shell-agent-btn term-shell-agent-btn--ghost"
            onClick={() => cancelShellAgent(sessionId)}
          >
            {t("terminal.shellAgent.cancel")}
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

  const askCard =
    showAskCard && askForm ? (
      <div
        className="term-shell-agent-card term-shell-agent-card--ask is-pending"
        onWheelCapture={(e) => {
          // 捕获阶段截住，避免滚轮落到 xterm（表单滚不动）
          e.stopPropagation();
        }}
      >
        <UserQuestionForm form={askForm} />
      </div>
    ) : null;

  const confirmCard =
    showConfirmCard && confirmTool && blockId ? (
      <div
        className={`term-shell-agent-card term-shell-agent-card--cmd ${danger ? "is-danger" : "is-pending"}`}
      >
        <div className="term-shell-agent-card__head">
          {danger ? (
            <span className="term-shell-agent-ico term-shell-agent-ico--danger" aria-hidden>
              !
            </span>
          ) : (
            <span className="term-shell-agent-ico term-shell-agent-ico--ai" aria-hidden>
              AI
            </span>
          )}
          <span className={`term-shell-agent-card__status-label ${danger ? "danger" : "accent"}`}>
            {danger
              ? t("terminal.shellAgent.danger")
              : t("terminal.shellAgent.awaitingApproval")}
          </span>
          <span className="term-shell-agent-card__head-spacer" />
          <span className="term-shell-agent-card__head-meta">
            {danger
              ? t("terminal.shellAgent.dangerMeta")
              : t("terminal.shellAgent.willExecute")}
          </span>
        </div>
        <div className="term-shell-agent-card__body">
          {pendingDesc ? (
            <p className="term-shell-agent-card__desc">{pendingDesc}</p>
          ) : null}
          {editing ? (
            <textarea
              className="term-shell-agent-card__edit"
              value={draft}
              rows={Math.min(6, Math.max(2, draft.split("\n").length))}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={t("terminal.shellAgent.editCommand")}
            />
          ) : resolveToolCommand(confirmTool) ? (
            <pre className="term-shell-agent-card__code">
              <code>{resolveToolCommand(confirmTool)}</code>
            </pre>
          ) : null}
          <div className="term-shell-agent-card__actions">
            <button
              type="button"
              className={
                danger
                  ? "term-shell-agent-btn term-shell-agent-btn--danger"
                  : "term-shell-agent-btn term-shell-agent-btn--primary"
              }
              onClick={() =>
                void approveInlineTerminalTool(
                  blockId,
                  confirmTool.id,
                  editing ? draft : undefined,
                )
              }
            >
              {danger
                ? t("terminal.shellAgent.confirmDanger")
                : t("terminal.shellAgent.agree")}
            </button>
            <button
              type="button"
              className="term-shell-agent-btn"
              onClick={() => rejectInlineTerminalTool(blockId, confirmTool.id)}
            >
              {t("ai.approval.reject")}
            </button>
            <button
              type="button"
              className="term-shell-agent-btn term-shell-agent-btn--ghost"
              onClick={() => {
                if (!editing) {
                  setDraft(resolveToolCommand(confirmTool));
                  setEditing(true);
                } else {
                  setEditing(false);
                }
              }}
            >
              {editing
                ? t("terminal.shellAgent.cancelEdit")
                : t("terminal.shellAgent.editCommand")}
            </button>
          </div>
        </div>
      </div>
    ) : null;

  const toolStripCards = showToolStrips
    ? stripTools.map((tc) => {
        const stateClass =
          tc.status === "running"
            ? "is-running"
            : tc.status === "failed" || tc.status === "rejected"
              ? "is-fail"
              : "is-done";
        const stateText =
          tc.status === "running"
            ? t("terminal.shellAgent.executing")
            : tc.status === "failed"
              ? t("terminal.shellAgent.failed")
              : tc.status === "rejected"
                ? t("terminal.shellAgent.rejected")
                : t("terminal.shellAgent.toolDone");
        return (
          <div
            key={tc.id}
            className={`term-shell-agent-tool ${stateClass}`}
            data-session-id={sessionId}
            data-tool-id={tc.id}
          >
            <span className="term-shell-agent-tool__ico" aria-hidden>
              {tc.status === "running" ? "…" : tc.status === "completed" ? "✓" : "×"}
            </span>
            <span className="term-shell-agent-tool__name">
              {t("terminal.shellAgent.toolCallName", {
                name: tc.toolName || "shell",
              })}
            </span>
            <span
              className={`term-shell-agent-tool__state${
                tc.status === "completed"
                  ? " ok"
                  : tc.status === "failed" || tc.status === "rejected"
                    ? " fail"
                    : ""
              }`}
            >
              · {stateText}
            </span>
            <span className="term-shell-agent-tool__spacer" />
            <button
              type="button"
              className="term-shell-agent-btn term-shell-agent-btn--ghost"
              data-shell-agent-expand
              onClick={(e) =>
                setDetail((prev) =>
                  toggleDetailFloat(prev, {
                    kind: "tool",
                    toolId: tc.id,
                    anchor: readAnchorRect(
                      e.currentTarget.closest(".term-shell-agent-tool") ??
                        e.currentTarget,
                    ),
                  }),
                )
              }
            >
              {t("terminal.shellAgent.viewTool")}
            </button>
          </div>
        );
      })
    : null;

  /** 结果卡：完整流式解读；滚轮勿交给 xterm */
  const finalCard = showFinal ? (
    <div
      className="term-shell-agent-card term-shell-agent-card--final is-interpret"
      onWheelCapture={(e) => {
        e.stopPropagation();
      }}
    >
      {latestAssistant ? (
        <div className="term-shell-agent-card__interpret">
          <ShellAgentMarkdown text={latestAssistant} />
        </div>
      ) : (
        <div className="term-shell-agent-card__interpret">
          {t("terminal.shellAgent.thinking")}
        </div>
      )}
      <div className="term-shell-agent-card__footer">
        <button
          type="button"
          className="term-shell-agent-btn term-shell-agent-btn--ghost"
          onClick={() => newShellAgentSession(sessionId)}
        >
          {t("terminal.shellAgent.newSession")}
        </button>
      </div>
    </div>
  ) : null;

  const detailTool =
    detail?.kind === "tool"
      ? toolCalls.find((tc) => tc.id === detail.toolId) ?? null
      : null;

  const detailFloat =
    detail === null
      ? null
      : createPortal(
          <div
            ref={floatRef}
            className="term-shell-agent-float"
            data-session-id={sessionId}
            style={floatStyleFromAnchor(detail.anchor)}
            role="complementary"
            aria-label={
              detail.kind === "thinking"
                ? t("terminal.shellAgent.thinkingDetail")
                : t("terminal.shellAgent.toolDetail")
            }
          >
            <div className="term-shell-agent-float__head">
              <span className="term-shell-agent-float__title">
                {detail.kind === "thinking"
                  ? t("terminal.shellAgent.thinkingDetail")
                  : t("terminal.shellAgent.toolDetail")}
              </span>
              <button
                type="button"
                className="term-shell-agent-btn term-shell-agent-btn--ghost"
                onClick={() => setDetail(null)}
              >
                {t("terminal.shellAgent.closeFloat")}
              </button>
            </div>
            <div className="term-shell-agent-float__body">
              {detail.kind === "thinking" ? (
                <>
                  {(detail.fullText || thinkingFull) ? (
                    <div className="term-shell-agent-float__section">
                      <ShellAgentMarkdown text={detail.fullText || thinkingFull} />
                    </div>
                  ) : (
                    <p className="term-shell-agent-float__empty">
                      {t("terminal.shellAgent.thinking")}
                    </p>
                  )}
                </>
              ) : null}
              {detail.kind === "tool" && detailTool ? (
                <div className="term-shell-agent-float__section">
                  <div className="term-shell-agent-float__label">
                    {toolStatusLabel(detailTool.status, t)}
                  </div>
                  <pre>
                    <code>{resolveToolCommand(detailTool) || detailTool.toolName}</code>
                  </pre>
                  {detailTool.args ? (
                    <pre className="term-shell-agent-float__result">
                      <code>{detailTool.args}</code>
                    </pre>
                  ) : null}
                  {detailTool.result ? (
                    <pre className="term-shell-agent-float__result">
                      <code>{detailTool.result}</code>
                    </pre>
                  ) : null}
                </div>
              ) : null}
              {detail.kind === "tool" && !detailTool && detail.commandFallback ? (
                <div className="term-shell-agent-float__section">
                  <div className="term-shell-agent-float__label">
                    {t("terminal.shellAgent.agreed")}
                  </div>
                  <pre>
                    <code>{detail.commandFallback}</code>
                  </pre>
                </div>
              ) : null}
            </div>
          </div>,
          document.body,
        );

  const cardBody = (
    <>
      {thinkingCard}
      {askCard}
      {confirmCard}
      {toolStripCards}
      {finalCard}
    </>
  );

  const withFloat = (node: ReactNode) => (
    <>
      {node}
      {detailFloat}
    </>
  );

  if (showDetachedFallback) {
    return withFloat(
      createPortal(
        <div
          className="term-shell-agent-detached"
          data-session-id={sessionId}
          data-phase={phase}
          role="dialog"
          aria-label={t("terminal.shellAgent.title")}
        >
          <div className="term-shell-agent-detached__banner">
            {t("terminal.shellAgent.detachedFallback")}
          </div>
          {cardBody}
        </div>,
        document.body,
      ),
    );
  }

  if (!inlineActive || !portalHost) return withFloat(null);

  return withFloat(
    createPortal(
      <div
        ref={measureRef}
        className="term-shell-agent-deco-card"
        data-session-id={sessionId}
        data-phase={phase}
        data-card-kind={cardKind ?? ""}
      >
        {cardBody}
      </div>,
      portalHost,
    ),
  );
}
