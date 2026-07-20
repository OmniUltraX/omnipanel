import { useAiStore } from "../../stores/aiStore";
import { AiAssistantBody } from "./assistant-ui/AiAssistantBody";
import {
  AiAssistantHeaderToolbar,
  AiConversationSwitcher,
} from "./assistant-ui/AiAssistantHeaderActions";
import { SubWindow } from "../ui/window/SubWindow";

export function AiDrawer() {
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const closeDrawer = useAiStore((s) => s.closeDrawer);

  return (
    <SubWindow
      open={drawerOpen}
      title={<AiConversationSwitcher />}
      onClose={closeDrawer}
      className="ai-subwindow"
      widthRatio={0.82}
      heightRatio={0.85}
      headerExtra={<AiAssistantHeaderToolbar />}
    >
      <div className="ai-subwindow-content ai-assistant-shell aui-shell">
        <AiAssistantBody showSideConversationList />
      </div>
    </SubWindow>
  );
}
