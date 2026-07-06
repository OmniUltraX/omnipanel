import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import { TerminalPaneView } from "../../terminal/TerminalPaneView";
import type { TerminalPane } from "../../../stores/terminalStore";

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
  if (!isTauriRuntime) {
    return (
      <div className="db-connection-cli-terminal db-connection-cli-terminal--idle">
        <div className="db-tables-panel-empty">
          请在 Tauri 桌面应用中运行以使用嵌入式终端（<code>npm run tauri dev</code>）
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
