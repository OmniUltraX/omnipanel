import { useRef } from "react";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import { useDockerContainerExecTerminal } from "./hooks/useDockerContainerExecTerminal";

export interface DockerContainerExecTerminalProps {
  connection: DockerConnectionInfo;
  containerId: string;
  running: boolean;
  isActive: boolean;
}

export function DockerContainerExecTerminal({
  connection,
  containerId,
  running,
  isActive,
}: DockerContainerExecTerminalProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  useDockerContainerExecTerminal(
    connection.connectionId,
    containerId,
    containerRef,
    isActive && running,
    true,
  );
  if (!running) {
    return (
      <div className="docker-container-exec docker-container-exec--stopped">
        {t("docker.containerPanel.execStopped")}
      </div>
    );
  }

  return (
    <div className="docker-container-exec">
      <div className="docker-container-exec__header">
        <span className="docker-container-exec__title">{t("docker.containerPanel.execTitle")}</span>
      </div>
      <div ref={containerRef} className="docker-container-exec__xterm term-xterm-wrap term-xterm-wrap--live-native" />
    </div>
  );
}
