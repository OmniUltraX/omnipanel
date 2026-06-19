import { useCallback } from "react";
import { useI18n } from "@/i18n";
import { OverviewStatsCards } from "@/modules/server/ssh/components/detail/OverviewStatsCards";
import { ProcessListPanel } from "@/modules/server/ssh/components/detail/ProcessListPanel";
import { useSshOverview } from "@/modules/server/ssh/hooks/useSshOverview";
import type { DetailTab } from "@/modules/server/ssh/types";
import { LOCAL_TERMINAL_RESOURCE_ID } from "@/modules/terminal/paneResource";
import { useLocalOverview } from "./useLocalOverview";

type Props = {
  mode: "local" | "remote";
  resourceId?: string | null;
  enableTunnels?: boolean;
  onOpenTunnelTab?: () => void;
};

/**
 * 终端侧栏监控 + 进程列表。
 * 在 dockview 面板内自行订阅概览数据，避免依赖 panelContentKey 刷新导致布局异常。
 */
export function AdvanceTerminalMonitorStack({
  mode,
  resourceId = null,
  enableTunnels = false,
  onOpenTunnelTab,
}: Props) {
  const { t } = useI18n();
  const localOverview = useLocalOverview(mode === "local");
  const sshOverview = useSshOverview(mode === "remote" ? resourceId : null);

  const {
    phase,
    stats,
    processes,
    error,
    updatedAt,
    refreshing,
    refreshProcesses,
    refresh,
  } = mode === "local" ? localOverview : sshOverview;

  const processResourceId =
    mode === "local" ? LOCAL_TERMINAL_RESOURCE_ID : (resourceId ?? null);

  const handleDetailTab = useCallback(
    (tab: DetailTab) => {
      if (tab === "tunnels") onOpenTunnelTab?.();
    },
    [onOpenTunnelTab],
  );

  return (
    <div className="advance-terminal-monitor-stack">
      <OverviewStatsCards
        embedded
        phase={phase}
        stats={stats}
        error={error}
        loadingMessage={mode === "local" ? t("terminal.monitor.loading") : undefined}
        onRetry={() => refresh()}
      />
      <ProcessListPanel
        resourceId={processResourceId}
        processes={processes}
        loading={refreshing}
        refreshing={refreshing}
        updatedAt={updatedAt}
        setDetailTab={handleDetailTab}
        onRefresh={refreshProcesses}
        enableTunnels={enableTunnels}
      />
    </div>
  );
}
