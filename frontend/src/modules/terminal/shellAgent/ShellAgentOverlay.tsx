import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
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
import { cancelShellAgent, newShellAgentSession, onShellAgentCardFitStable } from "./loop";
import {
  fitShellAgentCardToContent,
  getShellAgentGeometry,
  relayoutShellAgentCard,
  subscribeShellAgentGeometry,
} from "./shellAgentGeometry";
import { useShellAgentStore } from "./shellAgentStore";
import { ShellAgentMarkdown } from "./ShellAgentMarkdown";

type ShellAgentOverlayProps = {
  sessionId: string;
  promptSymbol?: string;
};

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

function shortAssistantNote(text: string, max = 220): string {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("```") && !l.startsWith("#"))
    .slice(0, 4)
    .join(" ")
    .slice(0, max);
}

function measureShellAgentCardHeight(container: HTMLElement): number {
  const card = container.querySelector<HTMLElement>(".term-shell-agent-card");
  if (!card) return 0;
  const rect = card.getBoundingClientRect();
  return Math.ceil(Math.max(rect.height, card.scrollHeight));
}

/**
 * 直通 Shell Agent：仅流内 xterm decoration + portal，无底部浮层。
 */
export function ShellAgentOverlay({ sessionId }: ShellAgentOverlayProps) {
  const { t } = useI18n();
  const agent = useShellAgentStore((s) => s.bySession[sessionId] ?? null);
  const blocks = useBlocksStore((s) => s.blocks[sessionId] ?? EMPTY_TERMINAL_BLOCKS);
  const [geoVersion, setGeoVersion] = useState(0);
  const [decoEl, setDecoEl] = useState<HTMLElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);

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

  // decoration 挂载：grow/relayout 中间态 decoration 可能短暂 null，勿立刻拆 portal
  useEffect(() => {
    const deco = geometry?.decoration ?? null;
    if (!deco) return;

    let cancelled = false;
    let renderDisposable: { dispose: () => void } | null = null;

    const attach = (el: HTMLElement) => {
      if (cancelled) return;
      el.style.pointerEvents = "auto";
      el.style.height = "auto";
      el.style.minHeight = "0";
      el.style.overflow = "visible";
      el.style.textAlign = "left";
      el.style.display = "block";
      el.style.alignItems = "flex-start";
      setDecoEl(el);
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
  }, [geometry?.decoration, geometry?.version]);

  useEffect(() => {
    if (!geometry?.cardKind && !geometry?.decoration) {
      setDecoEl(null);
    }
  }, [geometry?.cardKind, geometry?.decoration]);

  // resize：按新 cols 重注册 decoration 宽度
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

  const note = shortAssistantNote(latestAssistant, 180);

  const pendingTool = toolCalls.find((tc) => tc.status === "pending") ?? null;
  const activeTool =
    pendingTool ??
    toolCalls.find((tc) => tc.status === "running") ??
    (phase === "observing" || phase === "executing" || phase === "awaiting_approval"
      ? [...toolCalls]
          .reverse()
          .find((tc) => tc.status === "completed" || tc.status === "failed") ?? null
      : null);

  const busy =
    phase === "streaming" ||
    phase === "awaiting_approval" ||
    phase === "executing" ||
    phase === "observing";

  const showFinal = geometry?.cardKind === "final";
  const showOverlay = Boolean(blockId && agent) && (busy || showFinal);
  const inlineActive = Boolean(geometry?.cardKind && decoEl && showOverlay);

  useLayoutEffect(() => {
    if (!inlineActive) return;

    // 执行中不要扩高：原地扩会盖住命令输出。final 需要测高扩行（必要时重锚）。
    if (phase === "executing" || phase === "observing") return;

    const container = measureRef.current;
    if (!container) return;

    const isFinal = geometry?.cardKind === "final";
    const measure = () => {
      const h = measureShellAgentCardHeight(container);
      if (h <= 0) return;
      fitShellAgentCardToContent(
        sessionId,
        h,
        isFinal ? () => onShellAgentCardFitStable(sessionId) : undefined,
      );
    };

    measure();
    const card = container.querySelector<HTMLElement>(".term-shell-agent-card");
    const ro = new ResizeObserver(measure);
    ro.observe(card ?? container);
    return () => ro.disconnect();
  }, [
    inlineActive,
    sessionId,
    geometry?.cardKind,
    geometry?.version,
    phase,
    note,
    latestAssistant,
    activeTool?.id,
    activeTool?.status,
  ]);

  // TEMP-DEBUG: 每秒转储 overlay 状态 + buffer 尾部到 DOM dataset（隔离世界可读）
  useEffect(() => {
    const dump = () => {
      try {
        const term = getXterm(sessionId);
        const bufferTail: string[] = [];
        if (term) {
          const buf = term.buffer.active;
          const total = buf.length;
          for (let y = Math.max(0, total - 30); y < total; y += 1) {
            bufferTail.push(buf.getLine(y)?.translateToString(true) ?? "");
          }
        }
        const agentNow = useShellAgentStore.getState().bySession[sessionId] ?? null;
        const geoNow = getShellAgentGeometry(sessionId);
        document.body.dataset.shellAgentOverlay = JSON.stringify({
          t: Date.now(),
          phase: agentNow?.phase ?? null,
          blockId: agentNow?.blockId?.slice(0, 8) ?? null,
          geoMode: geoNow?.mode ?? null,
          cardKind: geoNow?.cardKind ?? null,
          cursorY: term ? term.buffer.active.cursorY + term.buffer.active.baseY : null,
          bufferTail,
        });
      } catch {
        // ignore
      }
    };
    const timer = window.setInterval(dump, 1000);
    dump();
    return () => window.clearInterval(timer);
  }, [sessionId]);

  if (!blockId || !agent) return null;
  if (!showOverlay) return null;

  const showThinking =
    phase === "streaming" && !activeTool && geometry?.cardKind !== "final";
  const showTool = Boolean(activeTool) && geometry?.cardKind !== "final";

  const thinkingCard = showThinking ? (
    <div className="term-shell-agent-card term-shell-agent-card--note">
      <span className="term-shell-agent-card__dot" />
      <div className="term-shell-agent-card__note">
        {note || t("terminal.shellAgent.thinking")}
      </div>
      <button
        type="button"
        className="term-shell-agent-card__link term-shell-agent-card__link--inline"
        onClick={() => cancelShellAgent(sessionId)}
      >
        {t("terminal.shellAgent.cancel")}
      </button>
    </div>
  ) : null;

  const toolCard = showTool && activeTool ? (
    <div className="term-shell-agent-card term-shell-agent-card--cmd">
      <div className="term-shell-agent-card__lead">
        {latestAssistant ? (
          <ShellAgentMarkdown text={latestAssistant} />
        ) : (
          t("terminal.shellAgent.proposeCommand")
        )}
      </div>
      <div className="term-shell-agent-card__status">
        {activeTool.status === "pending" ? (
          <span className="term-shell-agent-card__pending-label">
            {t("terminal.shellAgent.awaitingApproval")}
          </span>
        ) : (
          <span className="term-shell-agent-card__agreed">
            <span aria-hidden>✓</span>
            {t("terminal.shellAgent.agreed")}
          </span>
        )}
      </div>
      {resolveToolCommand(activeTool) ? (
        <pre className="term-shell-agent-card__code">
          <code>{resolveToolCommand(activeTool)}</code>
        </pre>
      ) : null}
      <div className="term-shell-agent-card__actions">
        {activeTool.status === "pending" ? (
          <>
            <button
              type="button"
              className="term-shell-agent-card__approve"
              onClick={() => void approveInlineTerminalTool(blockId, activeTool.id)}
            >
              {t("terminal.shellAgent.agree")}
            </button>
            <button
              type="button"
              className="term-shell-agent-card__reject"
              onClick={() => rejectInlineTerminalTool(blockId, activeTool.id)}
            >
              {t("ai.approval.reject")}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="term-shell-agent-card__link"
          onClick={() => newShellAgentSession(sessionId)}
        >
          {t("terminal.shellAgent.newSession")}
        </button>
        {phase === "streaming" || phase === "awaiting_approval" ? (
          <button
            type="button"
            className="term-shell-agent-card__link"
            onClick={() => cancelShellAgent(sessionId)}
          >
            {t("terminal.shellAgent.cancel")}
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

  const finalCard = showFinal ? (
    <div className="term-shell-agent-card term-shell-agent-card--final">
      {latestAssistant ? (
        <div className="term-shell-agent-card__note">
          <ShellAgentMarkdown text={latestAssistant} />
        </div>
      ) : null}
      <div className="term-shell-agent-card__footer">
        <button
          type="button"
          className="term-shell-agent-card__link"
          onClick={() => newShellAgentSession(sessionId)}
        >
          {t("terminal.shellAgent.newSession")}
        </button>
      </div>
    </div>
  ) : null;

  if (!inlineActive) return null;

  const cardKind = geometry!.cardKind ?? "";

  return createPortal(
    <div
      ref={measureRef}
      className="term-shell-agent-deco-card"
      data-session-id={sessionId}
      data-phase={phase}
      data-card-kind={cardKind}
    >
      {thinkingCard}
      {toolCard}
      {finalCard}
    </div>,
    decoEl,
  );
}
