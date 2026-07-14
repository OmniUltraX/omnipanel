import { useRef } from "react";
import { useI18n } from "../../i18n";
import type { DockerConnectionInfo } from "../../ipc/bindings";
import {
  isLocalDockerSource,
  isOnePanelDockerSource,
  isSshDockerSource,
  normalizeDockerSource,
} from "./dockerConnectionSource";
import {
  useDockerHostShellTerminal,
  useLocalDockerShellTerminal,
} from "./hooks/useDockerHostShellTerminal";

export interface DockerHostTerminalPanelProps {
  connection: DockerConnectionInfo;
  /** 连接 dock 是否处于激活态；激活且已访问过终端时保持 PTY 会话 */
  isActive?: boolean;
  /** 当前是否显示该页签（不控制会话启停） */
  visible?: boolean;
}

function HostShellMount({
  connectionId,
  isActive,
  mode,
}: {
  connectionId: string;
  isActive: boolean;
  mode: "ssh" | "local" | "onepanel";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // SSH / 1Panel 均走 dockerCreateHostShellSession + dockerExec*
  useDockerHostShellTerminal(
    connectionId,
    containerRef,
    isActive && (mode === "ssh" || mode === "onepanel"),
  );
  useLocalDockerShellTerminal(containerRef, isActive && mode === "local");
  return (
    <div
      ref={containerRef}
      className="docker-container-exec__xterm term-xterm-wrap term-xterm-wrap--live-native"
    />
  );
}

export function DockerHostTerminalPanel({
  connection,
  isActive = false,
  visible = false,
}: DockerHostTerminalPanelProps) {
  const { t } = useI18n();
  const source = normalizeDockerSource(connection.source);
  const ssh = isSshDockerSource(source);
  const local = isLocalDockerSource(source);
  const onepanel = isOnePanelDockerSource(source);

  if (!ssh && !local && !onepanel) {
    return (
      <div
        className="docker-host-terminal-panel"
        hidden={!visible}
        aria-hidden={!visible}
      >
        <div className="docker-container-exec docker-container-exec--unsupported">
          {t("docker.connectionPanel.terminalUnsupported")}
        </div>
      </div>
    );
  }

  const mode = ssh ? "ssh" : onepanel ? "onepanel" : "local";
  const title = ssh
    ? t("docker.connectionPanel.terminalSshTitle")
    : onepanel
      ? t("docker.connectionPanel.terminalOnePanelTitle")
      : t("docker.connectionPanel.terminalLocalTitle");

  return (
    <div
      className="docker-host-terminal-panel"
      hidden={!visible}
      aria-hidden={!visible}
    >
      <div className="docker-container-exec">
        <div className="docker-container-exec__header">
          <span className="docker-container-exec__title">{title}</span>
          <span className="docker-host-terminal-panel__hint">
            {t("docker.connectionPanel.terminalHint")}
          </span>
        </div>
        {isActive ? (
          <HostShellMount
            connectionId={connection.connectionId}
            isActive
            mode={mode}
          />
        ) : (
          <div className="docker-container-exec__xterm" />
        )}
      </div>
    </div>
  );
}
