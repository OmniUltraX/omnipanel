import type { DockerConnectionInfo } from "../../ipc/bindings";

interface DockerDockPanelProps {
  connection: DockerConnectionInfo;
  /** 当前连接 dock 面板处于激活态 */
  isActive: boolean;
}

/** 单个 Docker 连接的工作区；内容待重构。 */
export function DockerDockPanel({ connection: _connection, isActive }: DockerDockPanelProps) {
  if (!isActive) {
    return <div className="docker-dock-panel docker-dock-panel--inactive" aria-hidden />;
  }

  return (
    <div className="docker-dock-panel">
      <div className="docker-dock-panel-placeholder" />
    </div>
  );
}
