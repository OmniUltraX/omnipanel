import { useAiStore } from "../../stores/aiStore";
import { useSettingsStore } from "../../stores/settingsStore";

/** 右侧 AI Dock（dockview）是否处于打开态 */
export function useAiDockOpen(): boolean {
  const aiDisplayMode = useSettingsStore((s) => s.aiDisplayMode);
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  return aiDisplayMode === "dockview" && drawerOpen;
}
