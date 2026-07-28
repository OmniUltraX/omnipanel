import { memo, useMemo } from "react";
import { create } from "zustand";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  LoaderIcon,
  MinusIcon,
  XIcon,
  ListChecksIcon,
  XCircleIcon,
} from "lucide-react";
import type { PlanData, PlanStep, PlanStepStatus } from "../../lib/ai/aiMessageParts";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/primitives/Button";

/**
 * 会话内 PlanView 展开/折叠 UI 状态（按 planId 共享）。
 * 吸顶副本与对话流内嵌实例需同步；仅内存，不持久化。
 */
interface PlanUiState {
  collapsedByPlanId: Record<string, boolean>;
  setCollapsed: (planId: string, collapsed: boolean) => void;
}

const usePlanUiStore = create<PlanUiState>((set) => ({
  collapsedByPlanId: {},
  setCollapsed: (planId, collapsed) =>
    set((s) => ({
      collapsedByPlanId: { ...s.collapsedByPlanId, [planId]: collapsed },
    })),
}));

/** 读取某 plan 的折叠态（吸顶栈据此切换固定高度 / 仅头部高度） */
export function usePlanCollapsed(planId: string, defaultCollapsed = false): boolean {
  return usePlanUiStore((s) => s.collapsedByPlanId[planId] ?? defaultCollapsed);
}

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
  /** 是否默认折叠（嵌入式场景如顶部面板可默认折叠，对话流内默认展开） */
  defaultCollapsed?: boolean;
  /** 是否显示"取消剩余步骤"按钮（顶部面板场景启用） */
  showCancelRemaining?: boolean;
  /** 取消剩余步骤回调；不传则不显示按钮 */
  onCancelRemaining?: () => void;
  /**
   * 高度受限场景（如吸顶浮层）：头部/进度条/页脚固定，
   * 步骤列表在剩余空间内滚动。
   */
  scrollable?: boolean;
}

function PlanViewImpl({
  planId,
  snapshot,
  defaultCollapsed = false,
  showCancelRemaining = false,
  onCancelRemaining,
  scrollable = false,
}: PlanViewProps) {
  const { t } = useI18n();

  // 优先从 store 读取实时数据；store 无此计划时回退到快照
  const livePlan = useAiOrchestrationStore((s) => s.plans[planId]);
  const plan = livePlan ?? snapshot;
  // 吸顶 / 内嵌共用同一折叠状态
  const collapsed = usePlanUiStore(
    (s) => s.collapsedByPlanId[planId] ?? defaultCollapsed,
  );
  const setCollapsed = usePlanUiStore((s) => s.setCollapsed);

  const stats = useMemo(() => {
    if (!plan) return { done: 0, total: 0, failed: 0, remaining: 0 };
    const done = plan.steps.filter(
      (s) => s.status === "completed" || s.status === "skipped",
    ).length;
    const failed = plan.steps.filter((s) => s.status === "failed").length;
    const remaining = plan.steps.filter(
      (s) => s.status === "pending" || s.status === "in_progress",
    ).length;
    return { done, total: plan.steps.length, failed, remaining };
  }, [plan]);

  if (!plan) return null;

  const statusKey = PLAN_STATUS_LABEL_KEY[plan.status];
  const isRunning = plan.status === "executing" || plan.status === "planning";
  const canCancelRemaining = showCancelRemaining && isRunning && stats.remaining > 0 && onCancelRemaining;

  return (
    <div
      data-slot="ai-plan-view"
      data-plan-id={planId}
      className={cn(
        "rounded-md border border-border bg-bg-deeper shadow-sm overflow-hidden",
        // 嵌入式场景（对话流内）保留 my-2；吸顶/顶部面板由父容器控制间距
        defaultCollapsed === false && !scrollable && "my-2",
        scrollable && "flex min-h-0 max-h-full flex-1 flex-col",
      )}
    >
      {/* Header（可点击折叠） */}
      <button
        type="button"
        className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5 bg-bg w-full text-left hover:bg-bg-elevated transition-colors"
        onClick={() => setCollapsed(planId, !collapsed)}
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRightIcon className="h-3 w-3 text-fg-2 flex-shrink-0" />
        ) : (
          <ChevronDownIcon className="h-3 w-3 text-fg-2 flex-shrink-0" />
        )}
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
        <span className="text-[10px] text-fg-2 flex-shrink-0 tabular-nums">
          {stats.done}/{stats.total}
        </span>
      </button>

      {/* Progress bar（始终显示，折叠态作为视觉进度提示） */}
      {stats.total > 0 && (
        <div className="h-0.5 shrink-0 bg-bg">
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

      {/* Steps（折叠态隐藏） */}
      {!collapsed && (
        <>
          <div
            className={cn(
              "py-0.5",
              scrollable && "min-h-0 flex-1 overflow-y-auto overscroll-contain",
            )}
          >
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
            <div className="flex shrink-0 items-center gap-1 border-t border-border px-2.5 py-1 text-[10px] text-fg-2 bg-bg">
              <ChevronRightIcon className="h-3 w-3" />
              <span className="flex-1">
                {isRunning
                  ? t("ai.plan.progress", { done: stats.done, total: stats.total })
                  : t("ai.plan.completed", { done: stats.done, total: stats.total })}
                {stats.failed > 0 && ` · ${t("ai.plan.failed", { count: stats.failed })}`}
              </span>
              {canCancelRemaining && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancelRemaining?.();
                  }}
                >
                  <XCircleIcon className="h-3 w-3 mr-1" />
                  {t("ai.plan.cancelRemaining", { count: stats.remaining })}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export const PlanView = memo(PlanViewImpl);
