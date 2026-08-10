import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import { canUseTerminalBackend } from "../../../lib/isTauriRuntime";
import { TerminalPaneView } from "../../terminal/TerminalPaneView";
import type { TerminalPane } from "../../../stores/terminalStore";

interface ConnectionCliTerminalWorkspaceProps {
  pane: TerminalPane | null;
  resource: WorkspaceResource | null;
  paneId: string;
  reconnectKey: number;
  /** 命令行子标签是否处于前台（仅影响焦点，不断开 PTY/SSH）。 */
  terminalActive: boolean;
  onSenderChange: (sessionId: string, sender: ((cmd: string) => void) | null) => void;
}

export function ConnectionCliTerminalWorkspace({
  pane,
  resource,
  paneId,
  reconnectKey,
  terminalActive,
  onSenderChange,
}: ConnectionCliTerminalWorkspaceProps) {
  if (!canUseTerminalBackend()) {
    return (
      <div className="db-connection-cli-terminal db-connection-cli-terminal--idle">
        <div className="db-tables-panel-empty">
          当前构建未启用终端后端。请使用桌面应用或 Web 构建（
          <code>OMNIPANEL_WEB=1</code>）对接 <code>omnipanel-server</code>。
        </div>
      </div>
    );
  }

  if (!pane || !resource) {
    return (
      <div className="db-connection-cli-terminal db-connection-cli-terminal--idle">
        <div className="db-tables-panel-empty">正在初始化终端…</div>
      </div>
    );
  }

  return (
    <div className="db-connection-cli-terminal">
      <div className="term-panes">
        <TerminalPaneView
          key={`${paneId}:${reconnectKey}:${pane.type}:${pane.resourceId}`}
          paneId={pane.id}
          resource={resource}
          pane={pane}
          isActive={terminalActive}
          startup={[]}
          onActivate={() => {}}
          onSendCommand={() => {}}
          onSenderChange={onSenderChange}
        />
      </div>
    </div>
  );
}
