import { useMemo } from "react";
import { resolveResourceById } from "../../stores/connectionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { setTerminalPaneSender } from "./terminalPaneSenders";
import { TerminalView } from "./TerminalView";
import { AI_BACKGROUND_PURPOSE } from "./aiExecTerminal";

/**
 * 跟随关闭时，侧栏命令在这里跑：会话不进左侧标签栏，也不抢走当前页面。
 */
export function AiBackgroundTerminalHost() {
  const tabs = useTerminalStore((state) => state.tabs);
  const sessions = useMemo(
    () =>
      tabs.filter(
        (tab) => tab.workspaceOnly && tab.session.purpose === AI_BACKGROUND_PURPOSE,
      ),
    [tabs],
  );

  if (sessions.length === 0) return null;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        left: -12000,
        top: 0,
        width: 800,
        height: 480,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      {sessions.map((tab) => (
        <TerminalView
          key={tab.sessionId}
          sessionId={tab.sessionId}
          resource={resolveResourceById(tab.session.resourceId)}
          startup={tab.session.commandPack}
          active
          onSenderChange={setTerminalPaneSender}
        />
      ))}
    </div>
  );
}
