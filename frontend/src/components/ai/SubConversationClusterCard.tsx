import { useMemo, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  LoaderIcon,
  XIcon,
  MinusIcon,
  CornerDownRightIcon,
  XCircleIcon,
} from "lucide-react";
import { useAiStore } from "../../stores/aiStore";
import { useAiOrchestrationStore } from "../../stores/aiOrchestrationStore";
import type { SubConversationChildState } from "../../lib/ai/aiMessageParts";
import { cancelCluster } from "../../lib/ai/orchestration/clusterCancellation";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui/primitives/Button";

/** 子会话状态 → 图标 + 颜色 */
const CHILD_STATUS_CONFIG: Record<
  SubConversationChildState["status"],
  { icon: typeof CheckIcon; className: string; spin?: boolean; label: string }
> = {
  pending: { icon: CircleIcon, className: "text-fg-2", label: "common.pending" },
  running: { icon: LoaderIcon, className: "text-accent", spin: true, label: "common.running" },
  completed: { icon: CheckIcon, className: "text-success", label: "common.completed" },
  failed: { icon: XIcon, className: "text-destructive", label: "common.failed" },
  cancelled: { icon: MinusIcon, className: "text-fg-2", label: "common.cancelled" },
};

interface SubConversationClusterCardProps {
  clusterId: string;
  /** 嵌入式场景（对话流内）默认展开；顶部面板默认折叠 */
  defaultCollapsed?: boolean;
  /**
   * 取消整个集群回调。
   * 默认调用 `cancelCluster(clusterId)`；传 `null` 可隐藏取消按钮。
   */
  onCancelCluster?: (() => void) | null;
}

/**
 * 子会话集群卡片（cursor sub-agent 范式）。
 *
 * 收起态：标题 + 进度 N/M + 状态徽章
 * 展开态：列出每个子会话（标题 + 状态 + 进入按钮）+ 取消剩余按钮
 *
 * 数据来源：aiOrchestrationStore.clusters[clusterId]
 */
export function SubConversationClusterCard({
  clusterId,
  defaultCollapsed = false,
  onCancelCluster,
}: SubConversationClusterCardProps) {
  const { t } = useI18n();
  const cluster = useAiOrchestrationStore((s) => s.clusters[clusterId]);
  const setViewingChildConversation = useAiStore((s) => s.setViewingChildConversation);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const stats = useMemo(() => {
    if (!cluster) return { done: 0, total: 0, failed: 0, remaining: 0 };
    const children = cluster.children;
    const done = children.filter(
      (c) => c.status === "completed" || c.status === "failed" || c.status === "cancelled",
    ).length;
    const failed = children.filter((c) => c.status === "failed").length;
    const remaining = children.filter(
      (c) => c.status === "pending" || c.status === "running",
    ).length;
    return { done, total: children.length, failed, remaining };
  }, [cluster]);

  if (!cluster) return null;

  const isRunning = cluster.status === "running" || cluster.status === "pending";
  const handleCancelCluster =
    onCancelCluster === null
      ? null
      : (onCancelCluster ?? (() => cancelCluster(clusterId)));
  const showCancelButton = Boolean(handleCancelCluster) && isRunning && stats.remaining > 0;

  return (
    <div
      data-slot="sub-conv-cluster-card"
      data-cluster-status={cluster.status}
      className="ai-task-card"
    >
      {/* Header（可点击折叠） */}
      <button
        type="button"
        className="ai-task-card__header"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRightIcon className="h-3 w-3 text-fg-2 flex-shrink-0" />
        ) : (
          <ChevronDownIcon className="h-3 w-3 text-fg-2 flex-shrink-0" />
        )}
        <CornerDownRightIcon className="h-3 w-3 text-accent flex-shrink-0" />
        <strong className="truncate flex-1 text-left">{cluster.title}</strong>
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded-sm font-medium flex-shrink-0",
            cluster.status === "completed" && "bg-success/10 text-success",
            cluster.status === "failed" && "bg-destructive/10 text-destructive",
            cluster.status === "running" && "bg-accent/10 text-accent",
            cluster.status === "pending" && "bg-accent/10 text-accent",
            cluster.status === "cancelled" && "bg-fg-2/10 text-fg-2",
          )}
        >
          {t(`ai.cluster.status_${cluster.status}`)}
        </span>
        <span className="text-[10px] text-fg-2 flex-shrink-0 tabular-nums">
          {stats.done}/{stats.total}
        </span>
      </button>

      {/* 进度条 */}
      {stats.total > 0 && (
        <div className="h-0.5 bg-bg">
          <div
            className={cn(
              "h-full transition-all duration-300",
              stats.failed > 0 && cluster.status === "failed"
                ? "bg-destructive"
                : "bg-accent",
            )}
            style={{
              width: `${stats.total > 0 ? (stats.done / stats.total) * 100 : 0}%`,
            }}
          />
        </div>
      )}

      {/* 子会话列表（折叠态隐藏） */}
      {!collapsed && (
        <>
          <ul className="ai-task-card__children">
            {cluster.children.map((child) => {
              const config = CHILD_STATUS_CONFIG[child.status];
              const Icon = config.icon;
              return (
                <li key={child.conversationId}>
                  <button
                    type="button"
                    className="ai-task-child-btn"
                    onClick={() => setViewingChildConversation(child.conversationId)}
                    title={child.summary ?? child.title}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Icon
                        className={cn(
                          "h-3 w-3 flex-shrink-0",
                          config.className,
                          config.spin && "animate-spin",
                        )}
                      />
                      <span className="truncate">{child.title}</span>
                    </span>
                    <span className="setting-hint flex-shrink-0">
                      {t(config.label)}
                    </span>
                  </button>
                  {child.error && (
                    <div className="text-[10px] text-destructive leading-snug px-2 py-0.5">
                      {child.error}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Footer */}
          <div className="ai-task-card__actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setViewingChildConversation(cluster.children[0]?.conversationId)}
              disabled={cluster.children.length === 0}
            >
              {t("ai.cluster.viewSubConversations")}
            </Button>
            {showCancelButton && handleCancelCluster && (
              <Button variant="ghost" size="sm" onClick={() => handleCancelCluster()}>
                <XCircleIcon className="h-3 w-3 mr-1" />
                {t("ai.cluster.cancelRemaining", { count: stats.remaining })}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
