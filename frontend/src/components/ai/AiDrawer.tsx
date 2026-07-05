import { useAiStore } from "../../stores/aiStore";
import { AiAssistantBody } from "./assistant-ui/AiAssistantBody";
import { AiAssistantHeaderToolbar } from "./assistant-ui/AiAssistantHeaderActions";
import { AiConversationTitle } from "./assistant-ui/AiConversationTitle";
import { SubWindow } from "../ui/window/SubWindow";

export function AiDrawer() {
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const closeDrawer = useAiStore((s) => s.closeDrawer);

  return (
    <SubWindow
      open={drawerOpen}
      title={
        <AiConversationTitle
          as="h2"
          id="subwindow-title"
          className="subwindow-title"
        />
      }
      onClose={closeDrawer}
      className="ai-subwindow"
      widthRatio={0.82}
      heightRatio={0.85}
      headerExtra={<AiAssistantHeaderToolbar />}
    >
      <div className="ai-subwindow-content ai-assistant-shell aui-shell">
        <AiAssistantBody />
      </div>
    </SubWindow>
  );
}
