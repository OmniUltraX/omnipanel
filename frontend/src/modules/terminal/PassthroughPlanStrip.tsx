import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { PlanView } from "../../components/ai/PlanView";
import { useI18n } from "../../i18n";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import { useBlocksStore } from "../../stores/blocksStore";
import { useShellAgentStore } from "./shellAgent/shellAgentStore";
import {
  extractLatestPlanSnapshot,
  resolvePlanCompactBadge,
} from "./terminalAiPlan";

type PassthroughPlanStripProps = {
  sessionId: string;
};

const expandedStorageKey = (sessionId: string) =>
  `omnipanel.passthrough-plan.expanded:${sessionId}`;

function readExpanded(sessionId: string): boolean {
  try {
    const raw = localStorage.getItem(expandedStorageKey(sessionId));
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // ignore
  }
  return false;
}

function writeExpanded(sessionId: string, open: boolean): void {
  try {
    localStorage.setItem(expandedStorageKey(sessionId), open ? "1" : "0");
  } catch {
    // ignore
  }
}

/**
 * 直通 pane 右下角 Plan：收起为窄条，展开为同体面板（状态按会话持久化）。
 */
export function PassthroughPlanStrip({ sessionId }: PassthroughPlanStripProps) {
  const { t } = useI18n();
  const blockId = useShellAgentStore((s) => s.get(sessionId)?.blockId ?? null);
  const block = useBlocksStore((s) =>
    blockId ? s.findBlockById(blockId) : null,
  );
  const snapshot = useMemo(() => extractLatestPlanSnapshot(block), [block]);
  const livePlan = useAiOrchestrationStore((s) =>
    snapshot ? (s.plans[snapshot.id] ?? null) : null,
  );
  const plan = livePlan ?? snapshot;

  const badge = useMemo(() => {
    if (!plan) return null;
    return resolvePlanCompactBadge(plan, {
      completed: t("ai.plan.statusCompleted"),
      failed: t("ai.plan.statusFailed"),
      cancelled: t("ai.plan.statusCancelled"),
      executing: t("ai.plan.statusExecuting"),
      planning: t("ai.plan.statusPlanning"),
    });
  }, [plan, t]);

  const [expanded, setExpanded] = useState(() => readExpanded(sessionId));

  useEffect(() => {
    setExpanded(readExpanded(sessionId));
  }, [sessionId]);

  const toggle = useCallback(() => {
    setExpanded((v) => {
      const next = !v;
      writeExpanded(sessionId, next);
      return next;
    });
  }, [sessionId]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setExpanded(false);
      writeExpanded(sessionId, false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded, sessionId]);

  if (!plan || !badge) return null;

  const toneClass =
    badge.tone === "completed"
      ? "is-done"
      : badge.tone === "failed" || badge.tone === "cancelled"
        ? "is-fail"
        : "is-running";

  const title = plan.title?.trim() || t("ai.plan.statusExecuting");

  return (
    <div
      className={`term-passthrough-plan ${toneClass}${expanded ? " is-expanded" : ""}`}
      data-session-id={sessionId}
      data-plan-id={plan.id}
      data-expanded={expanded ? "1" : "0"}
      onWheelCapture={(e) => {
        // 捕获阶段截住，否则滚轮落到 xterm，面板只能拖滚动条
        e.stopPropagation();
      }}
    >
      {expanded ? (
        <div className="term-passthrough-plan__panel" role="complementary" aria-label={title}>
          <div className="term-passthrough-plan__panel-head">
            <span className="term-passthrough-plan__panel-title">{title}</span>
            <button
              type="button"
              className="term-shell-agent-btn term-shell-agent-btn--ghost"
              onClick={toggle}
            >
              {t("terminal.ai.collapse")}
            </button>
          </div>
          <div className="term-passthrough-plan__panel-body">
            {/* 不启用 PlanView 内部 scrollable，避免双层滚动抢滚轮；由 panel-body 统一滚 */}
            <PlanView planId={plan.id} snapshot={plan} defaultCollapsed={false} />
          </div>
        </div>
      ) : null}
      <button
        type="button"
        className="term-passthrough-plan__bar"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={title}
      >
        <span className="term-passthrough-plan__ico" aria-hidden>
          ≡
        </span>
        <span className="term-passthrough-plan__progress">{badge.progress}</span>
        <span className="term-passthrough-plan__detail">{badge.detail}</span>
        <span className="term-passthrough-plan__toggle">
          {expanded ? t("terminal.ai.collapse") : t("terminal.ai.expand")}
        </span>
      </button>
    </div>
  );
}
