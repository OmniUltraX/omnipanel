import { AiDockChrome } from "./AiDockChrome";
import { AiAssistantBody } from "./AiAssistantBody";

export interface AiAssistantShellProps {
  showDockHeader?: boolean;
}

export function AiAssistantShell({ showDockHeader }: AiAssistantShellProps) {
  return (
    <div className="ai-assistant-shell aui-shell">
      {showDockHeader ? <AiDockChrome /> : null}
      <AiAssistantBody showToolbar={Boolean(showDockHeader)} />
    </div>
  );
}
