import { create } from "zustand";

/** 与 SettingsPanel 侧栏分区 id 对齐 */
export type SettingsNavSection =
  | "general"
  | "system"
  | "plugins"
  | "appearance"
  | "keybindings"
  | "ai"
  | "aiServices"
  | "security"
  | "accounts"
  | "terminal"
  | "database"
  | "files"
  | "protocol"
  | "knowledge";

interface SettingsUiState {
  open: boolean;
  /** 当前选中的设置分区（打开时指定则跳转；面板内切换也会写回） */
  section: SettingsNavSection;
  openSettings: (section?: SettingsNavSection) => void;
  closeSettings: () => void;
  toggleSettings: () => void;
  setSection: (section: SettingsNavSection) => void;
}

export const useSettingsUiStore = create<SettingsUiState>((set) => ({
  open: false,
  section: "general",
  openSettings: (section) =>
    set({
      open: true,
      // 显式传入则跳转；否则保留上次分区
      ...(section != null ? { section } : {}),
    }),
  closeSettings: () => set({ open: false }),
  toggleSettings: () => set((s) => ({ open: !s.open })),
  setSection: (section) => set({ section }),
}));
