import { useEffect } from "react";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import { canUseTerminalBackend } from "../../../../lib/isTauriRuntime";
import { getBlueprint } from "../../../terminal/sessionBlueprints";
import { useSshTerminalWorkspace } from "../hooks/useSshTerminalWorkspace";
import { useSshDetailNavigationStore } from "../../../../stores/sshDetailNavigationStore";
import { TerminalPaneView } from "../../../terminal/TerminalPaneView";

type Props = {
  resource: WorkspaceResource | null;
  active?: boolean;
};

export function SshTerminalWorkspace({ resource, active = true }: Props) {
  const {
    activePaneId,
    activePane,
    handleSenderChange,
    handleCommand,
    hasPaneSender,
  } = useSshTerminalWorkspace(resource, active);

  const pendingTerminal = useSshDetailNavigationStore((s) => s.pendingTerminal);
  const consumeTerminalCommand = useSshDetailNavigationStore((s) => s.consumeTerminalCommand);

  useEffect(() => {
    if (!active || !pendingTerminal || !activePaneId || !resource?.id) return;
    if (pendingTerminal.resourceId !== resource.id) return;

    let cancelled = false;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (cancelled) return;
      attempts += 1;
      if (!hasPaneSender(activePaneId)) {
        if (attempts >= 50) {
          window.clearInterval(timer);
        }
        return;
      }
      const pending = consumeTerminalCommand(resource.id);
      if (pending) {
        handleCommand(`${pending.command}\n`);
      }
      window.clearInterval(timer);
    }, 100);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    active,
    pendingTerminal,
    activePaneId,
    resource?.id,
    hasPaneSender,
    handleCommand,
    consumeTerminalCommand,
  ]);

  if (!resource) {
    return (
      <div className="ssh-terminal-panel">
        <div className="ssh-terminal-empty">请从左侧列表选择一台主机</div>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="ssh-terminal-panel">
        <div className="ssh-terminal-empty">切换到终端页签后将建立 SSH 连接</div>
      </div>
    );
  }

  if (!canUseTerminalBackend()) {
    return (
      <div className="ssh-terminal-panel">
        <div className="ssh-terminal-empty">
          当前构建未启用终端后端。请使用桌面应用（
          <code>npm run tauri dev</code>）或 Web 构建（
          <code>OMNIPANEL_WEB=1</code>）对接 <code>omnipanel-server</code>。
        </div>
      </div>
    );
  }

  if (!activePane) {
    return (
      <div className="ssh-terminal-panel">
        <div className="ssh-terminal-empty">正在初始化终端…</div>
      </div>
    );
  }

  return (
    <div className="ssh-terminal-panel ssh-terminal-workspace">
      <div className="term-panes">
        <TerminalPaneView
          paneId={activePane.id}
          resource={resource}
          pane={activePane}
          isActive
          startup={getBlueprint(resource, activePane).startup}
          onActivate={() => {}}
          onSendCommand={handleCommand}
          onSenderChange={handleSenderChange}
        />
      </div>
    </div>
  );
}
