import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { PlanView } from "../../components/ai/PlanView";
import type { PlanData } from "../../lib/ai/aiMessageParts";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import { useI18n } from "../../i18n";
import {
  cancelTerminalBlockPlanRemaining,
  resolvePlanCompactBadge,
} from "./terminalAiPlan";

type TerminalAiPlanHoverBadgeProps = {
  blockId: string;
  plan: PlanData;
};

/**
 * 终端 AI 标题栏计划进度：默认显示「进度 · 当前步骤」，悬停/点击弹出完整 PlanView。
 */
export function TerminalAiPlanHoverBadge({
  blockId,
  plan,
}: TerminalAiPlanHoverBadgeProps) {
  const { t } = useI18n();
  const livePlan = useAiOrchestrationStore((s) => s.plans[plan.id] ?? null);
  const resolved = livePlan ?? plan;

  const badge = useMemo(
    () =>
      resolvePlanCompactBadge(resolved, {
        completed: t("ai.plan.statusCompleted"),
        failed: t("ai.plan.statusFailed"),
        cancelled: t("ai.plan.statusCancelled"),
        executing: t("ai.plan.statusExecuting"),
        planning: t("ai.plan.statusPlanning"),
      }),
    [resolved, t],
  );

  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [ready, setReady] = useState(false);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const openPanel = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);

  const scheduleClose = useCallback(() => {
    if (pinned) return;
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 160);
  }, [clearCloseTimer, pinned]);

  const closeAll = useCallback(() => {
    clearCloseTimer();
    setPinned(false);
    setOpen(false);
  }, [clearCloseTimer]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const anchorRect = anchor.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const panelW = width > 0 ? width : 360;
    const panelH = height > 0 ? height : 240;

    let left = anchorRect.right - panelW;
    left = Math.max(margin, Math.min(left, window.innerWidth - panelW - margin));

    const spaceBelow = window.innerHeight - anchorRect.bottom - gap;
    const spaceAbove = anchorRect.top - gap;
    const openBelow =
      spaceBelow >= Math.min(panelH, 200) || spaceBelow >= spaceAbove;
    const top = openBelow
      ? anchorRect.bottom + gap
      : Math.max(margin, anchorRect.top - gap - panelH);

    setCoords({ left, top });
    setReady(true);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setReady(false);
      setCoords(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition, resolved.updatedAt, resolved.steps.length]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updatePosition());
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAll();
      }
    };
    const onScroll = () => updatePosition();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, closeAll, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      closeAll();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open, closeAll]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  const ariaLabel = `${resolved.title} ${badge.progress} ${badge.detail}`;

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className={`term-warp-ai-plan-progress term-warp-ai-plan-progress--${badge.tone}${open ? " is-open" : ""}`}
        title={`${resolved.title}\n${badge.progress} · ${badge.detail}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          if (pinned && open) {
            closeAll();
            return;
          }
          setPinned(true);
          openPanel();
        }}
        onMouseEnter={openPanel}
        onMouseLeave={scheduleClose}
      >
        {badge.tone === "running" ? (
          <span className="term-warp-ai-plan-progress__dot" aria-hidden />
        ) : null}
        <span className="term-warp-ai-plan-progress__count">{badge.progress}</span>
        <span className="term-warp-ai-plan-progress__sep" aria-hidden>
          ·
        </span>
        <span className="term-warp-ai-plan-progress__detail">{badge.detail}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className={`term-warp-ai-plan-popover${ready ? " is-ready" : ""}`}
              style={coords ?? undefined}
              role="dialog"
              aria-label={resolved.title}
              onMouseEnter={openPanel}
              onMouseLeave={scheduleClose}
              onClick={(event) => event.stopPropagation()}
            >
              <PlanView
                planId={resolved.id}
                snapshot={resolved}
                defaultCollapsed={false}
                showCancelRemaining
                scrollable
                onCancelRemaining={() =>
                  cancelTerminalBlockPlanRemaining(blockId, resolved.id)
                }
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
