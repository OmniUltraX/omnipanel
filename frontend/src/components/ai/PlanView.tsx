import { memo, useMemo } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  LoaderIcon,
  MinusIcon,
  XIcon,
  ListChecksIcon,
} from "lucide-react";
import type { PlanData, PlanStep, PlanStepStatus } from "../../lib/ai/aiMessageParts";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";

const STATUS_CONFIG: Record<
  PlanStepStatus,
  { icon: typeof CheckIcon; className: string; spin?: boolean }
> = {
  pending: { icon: CircleIcon, className: "text-fg-2" },
  in_progress: { icon: LoaderIcon, className: "text-accent", spin: true },
  completed: { icon: CheckIcon, className: "text-success" },
  failed: { icon: XIcon, className: "text-destructive" },
  skipped: { icon: MinusIcon, className: "text-fg-2" },
};

const PLAN_STATUS_LABEL_KEY: Record<PlanData["status"], string> = {
  planning: "ai.plan.statusPlanning",
  executing: "ai.plan.statusExecuting",
  completed: "ai.plan.statusCompleted",
  failed: "ai.plan.statusFailed",
  cancelled: "ai.plan.statusCancelled",
};

function StepRow({ step, index }: { step: PlanStep; index: number }) {
  const config = STATUS_CONFIG[step.status];
  const Icon = config.icon;

  return (
    <div
      className="flex items-start gap-2 px-2 py-1.5 text-xs"
      data-slot="plan-step"
      data-status={step.status}
    >
      <span className="mt-0.5 flex-shrink-0 text-fg-2 tabular-nums">
        {index + 1}.
      </span>
      <Icon
        className={cn(
          "mt-0.5 h-3.5 w-3.5 flex-shrink-0",
          config.className,
          config.spin && "animate-spin",
        )}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "leading-snug",
            step.status === "completed" && "text-fg-2 line-through",
            step.status === "failed" && "text-destructive",
            step.status === "skipped" && "text-fg-2 line-through",
            step.status === "pending" && "text-fg-2",
            step.status === "in_progress" && "text-fg font-medium",
          )}
        >
          {step.title}
        </div>
        {step.summary && (
          <div className="mt-0.5 text-fg-2 leading-snug">
            {step.summary}
          </div>
        )}
        {step.error && (
          <div className="mt-0.5 text-destructive leading-snug">
            {step.error}
          </div>
        )}
        {step.toolName && step.status === "in_progress" && (
          <div className="mt-0.5 text-fg-2 font-mono text-[10px] leading-snug">
            {step.toolName}
          </div>
        )}
      </div>
    </div>
  );
}

interface PlanViewProps {
  /** 计划 ID：优先从 orchestration store 读取实时数据 */
  planId: string;
  /** 快照：当 store 中无此计划时（如旧会话恢复）回退使用 */
  snapshot?: PlanData;
}

function PlanViewImpl({ planId, snapshot }: PlanViewProps) {
  const { t } = useI18n();

  // 优先从 store 读取实时数据；store 无此计划时回退到快照
  const livePlan = useAiOrchestrationStore((s) => s.plans[planId]);
  const plan = livePlan ?? snapshot;

  const stats = useMemo(() => {
    if (!plan) return { done: 0, total: 0, failed: 0 };
    const done = plan.steps.filter(
      (s) => s.status === "completed" || s.status === "skipped",
    ).length;
    const failed = plan.steps.filter((s) => s.status === "failed").length;
    return { done, total: plan.steps.length, failed };
  }, [plan]);

  if (!plan) return null;

  const statusKey = PLAN_STATUS_LABEL_KEY[plan.status];
  const isRunning = plan.status === "executing" || plan.status === "planning";

  return (
    <div
      data-slot="ai-plan-view"
      className="my-2 rounded-md border border-border bg-bg-deeper shadow-sm overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 bg-bg">
        <ListChecksIcon className="h-3.5 w-3.5 text-accent flex-shrink-0" />
        <span className="text-xs font-medium text-fg truncate flex-1">
          {plan.title}
        </span>
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded-sm font-medium flex-shrink-0",
            plan.status === "completed" && "bg-success/10 text-success",
            plan.status === "failed" && "bg-destructive/10 text-destructive",
            plan.status === "executing" && "bg-accent/10 text-accent",
            plan.status === "planning" && "bg-accent/10 text-accent",
            plan.status === "cancelled" && "bg-fg-2/10 text-fg-2",
          )}
        >
          {t(statusKey)}
        </span>
      </div>

      {/* Progress bar */}
      {stats.total > 0 && (
        <div className="h-0.5 bg-bg">
          <div
            className={cn(
              "h-full transition-all duration-300",
              stats.failed > 0 && plan.status === "failed"
                ? "bg-destructive"
                : "bg-accent",
            )}
            style={{
              width: `${stats.total > 0 ? (stats.done / stats.total) * 100 : 0}%`,
            }}
          />
        </div>
      )}

      {/* Steps */}
      <div className="py-0.5">
        {plan.steps.map((step, i) => (
          <StepRow key={step.id} step={step} index={i} />
        ))}
        {plan.steps.length === 0 && (
          <div className="px-2.5 py-2 text-xs text-fg-2">
            {t("ai.plan.emptySteps")}
          </div>
        )}
      </div>

      {/* Footer */}
      {stats.total > 0 && (
        <div className="flex items-center gap-1 border-t border-border px-2.5 py-1 text-[10px] text-fg-2 bg-bg">
          <ChevronRightIcon className="h-3 w-3" />
          <span>
            {isRunning
              ? t("ai.plan.progress", { done: stats.done, total: stats.total })
              : t("ai.plan.completed", { done: stats.done, total: stats.total })}
            {stats.failed > 0 && ` · ${t("ai.plan.failed", { count: stats.failed })}`}
          </span>
        </div>
      )}
    </div>
  );
}

export const PlanView = memo(PlanViewImpl);
