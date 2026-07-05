import { useCallback } from "react";
import { useI18n } from "@/i18n";
import { MonitoringDashboard } from "@/modules/server/ssh/components/monitoring/MonitoringDashboard";
import { ProcessListPanel } from "@/modules/server/ssh/components/detail/ProcessListPanel";
import { useSshOverview } from "@/modules/server/ssh/hooks/useSshOverview";
import type { DetailTab } from "@/modules/server/ssh/types";
import { LOCAL_TERMINAL_RESOURCE_ID } from "@/modules/terminal/paneResource";
import { resolveResourceById } from "@/stores/connectionStore";
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
    processError,
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

  const resource = mode === "remote" && resourceId ? resolveResourceById(resourceId) : null;

  return (
    <div className="advance-terminal-monitor-stack">
      <MonitoringDashboard
        compact
        phase={phase}
        stats={stats}
        error={error}
        hostLabel={resource?.name ?? stats?.hostName}
        hostAddress={resource?.subtitle}
        updatedAt={updatedAt}
        refreshing={refreshing}
        processCount={processes.length}
        loadingMessage={mode === "local" ? t("terminal.monitor.loading") : undefined}
        onRetry={() => refresh()}
        onRefresh={() => refresh()}
      >
        <ProcessListPanel
          resourceId={processResourceId}
          processes={processes}
          loading={refreshing}
          refreshing={refreshing}
          updatedAt={updatedAt}
          error={processError ?? error}
          setDetailTab={handleDetailTab}
          onRefresh={refreshProcesses}
          enableTunnels={enableTunnels}
          variant="monitor"
        />
      </MonitoringDashboard>
    </div>
  );
}
