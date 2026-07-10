import { useSshOverview } from "@/modules/server/ssh/hooks/useSshOverview";
import type { SshManagerContext } from "@/modules/server/ssh/hooks/useSshManager";
import { MonitoringDashboard } from "@/modules/server/ssh/components/monitoring/MonitoringDashboard";
import { ProcessListPanel } from "@/components/server";

type Props = Pick<SshManagerContext, "activeResource">;

export function OverviewDetailTab({ activeResource }: Props) {
  const resourceId = activeResource?.id ?? null;

  const {
    phase,
    stats,
    processes,
    error,
    updatedAt,
    refreshing,
    refreshProcesses,
    refresh,
  } = useSshOverview(resourceId);

  return (
    <div className="ssh-ov-page">
      <MonitoringDashboard
        phase={phase}
        stats={stats}
        error={error}
        updatedAt={updatedAt}
        refreshing={refreshing}
        processCount={processes.length}
        hideStatusBar
        onRetry={() => refresh()}
        onRefresh={() => refresh()}
      >
        <ProcessListPanel
          resourceId={resourceId}
          processes={processes}
          loading={refreshing}
          refreshing={refreshing}
          updatedAt={updatedAt}
          onRefresh={refreshProcesses}
          variant="monitor"
        />
      </MonitoringDashboard>
    </div>
  );
}
