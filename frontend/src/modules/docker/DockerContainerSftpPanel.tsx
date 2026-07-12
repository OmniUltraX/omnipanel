import { useMemo } from "react";
import { SftpPanel } from "../../components/sftp";
import type { DockerConnectionSource } from "../../ipc/bindings";
import { makeDockerContainerSftpAdapter } from "./dockerContainerSftpAdapter";

export interface DockerContainerSftpPanelProps {
  connectionId: string;
  containerId: string;
  source: DockerConnectionSource;
  className?: string;
}

export function DockerContainerSftpPanel({
  connectionId,
  containerId,
  source,
  className,
}: DockerContainerSftpPanelProps) {
  const adapter = useMemo(
    () => makeDockerContainerSftpAdapter(connectionId, containerId, source),
    [connectionId, containerId, source],
  );
  const cacheKey = `${connectionId}:${containerId}`;

  return (
    <div className={className}>
      <SftpPanel resourceId={null} adapter={adapter} cacheKey={cacheKey} />
    </div>
  );
}
