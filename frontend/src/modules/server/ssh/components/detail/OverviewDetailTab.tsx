import type { useSshOverview } from "@/modules/server/ssh/hooks/useSshOverview";
import type { SshManagerContext } from "@/modules/server/ssh/hooks/useSshManager";
import { MonitoringDashboard } from "@/modules/server/ssh/components/monitoring/MonitoringDashboard";
import { ProcessListPanel } from "@/components/server";

type OverviewState = ReturnType<typeof useSshOverview>;

type Props = Pick<SshManagerContext, "activeResource"> & {
  overview: OverviewState;
};

export function OverviewDetailTab({ activeResource, overview }: Props) {
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
  } = overview;

  return (
    <div className="ssh-ov-page">
      <MonitoringDashboard
        phase={phase}
        stats={stats}
        error={error}
        processCount={processes.length}
        hideStatusBar
        onRetry={() => refresh()}
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
