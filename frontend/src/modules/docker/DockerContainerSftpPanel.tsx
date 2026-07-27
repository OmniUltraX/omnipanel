import { useMemo } from "react";
import { SftpPanel } from "../../components/sftp";
import { useI18n } from "../../i18n";
import type { DockerConnectionSource } from "../../ipc/bindings";
import { makeDockerContainerSftpAdapter } from "./dockerContainerSftpAdapter";

export interface DockerContainerSftpPanelProps {
  connectionId: string;
  containerId: string;
  source: DockerConnectionSource;
  /** 容器是否处于运行态；停止时不调用 docker exec，避免命令窗闪烁与报错。 */
  running?: boolean;
  className?: string;
}

export function DockerContainerSftpPanel({
  connectionId,
  containerId,
  source,
  running = true,
  className,
}: DockerContainerSftpPanelProps) {
  const { t } = useI18n();
  const adapter = useMemo(
    () => makeDockerContainerSftpAdapter(connectionId, containerId, source),
    [connectionId, containerId, source],
  );
  const cacheKey = `${connectionId}:${containerId}`;

  if (!running) {
    return (
      <div className={`docker-container-sftp-panel docker-container-sftp-panel--stopped ${className ?? ""}`}>
        {t("docker.containerPanel.filesStopped")}
      </div>
    );
  }

  return (
    <div className={className}>
      <SftpPanel resourceId={null} adapter={adapter} cacheKey={cacheKey} />
    </div>
  );
}
