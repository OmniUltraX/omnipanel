import { useAiStore } from "../../stores/aiStore";
import { AiPanelBody } from "./AiDrawer";

export function AiDockView() {
  const drawerOpen = useAiStore((s) => s.drawerOpen);

  return (
    <div className={`ai-dockview${drawerOpen ? " open" : ""}`}>
      <AiPanelBody />
    </div>
  );
}
