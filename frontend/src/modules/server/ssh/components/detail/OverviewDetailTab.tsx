import { useSshOverview } from "../../hooks/useSshOverview";
import type { SshManagerContext } from "../../hooks/useSshManager";
import { OverviewStatsCards } from "./OverviewStatsCards";
import { ProcessListPanel } from "./ProcessListPanel";

type Props = Pick<
  SshManagerContext,
  "profile" | "activeResource" | "setDetailTab"
>;

export function OverviewDetailTab({
  profile,
  activeResource,
  setDetailTab,
}: Props) {
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
      <OverviewStatsCards
        phase={phase}
        stats={stats}
        error={error}
        fallback={{
          cpu: profile.cpu,
          memory: profile.memory,
          disk: profile.disk,
        }}
        onRetry={() => refresh()}
      />
      <ProcessListPanel
        resourceId={resourceId}
        processes={processes}
        loading={refreshing}
        refreshing={refreshing}
        updatedAt={updatedAt}
        setDetailTab={setDetailTab}
        onRefresh={refreshProcesses}
      />
    </div>
  );
}
