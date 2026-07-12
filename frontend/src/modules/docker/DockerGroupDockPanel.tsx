import type { DockerConnectionInfo } from "../../ipc/bindings";
import { useDockerServiceGroupStore, selectDockerServiceGroup } from "../../stores/dockerServiceGroupStore";
import { DockerDockPanel } from "./DockerDockPanel";

interface DockerGroupDockPanelProps {
  connection: DockerConnectionInfo;
  serviceGroupId: string;
  isActive: boolean;
}

export function DockerGroupDockPanel({
  connection,
  serviceGroupId,
  isActive,
}: DockerGroupDockPanelProps) {
  const group = useDockerServiceGroupStore(
    selectDockerServiceGroup(connection.connectionId, serviceGroupId),
  );

  return (
    <DockerDockPanel
      connection={connection}
      isActive={isActive}
      panelTitle={group?.name}
      panelSubtitle={connection.hostLabel}
      containerIds={group?.containerIds}
    />
  );
}
