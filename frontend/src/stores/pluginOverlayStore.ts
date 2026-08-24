import { create } from "zustand";

export type PluginOverlayEntry = {
  id: string;
  pluginId: string;
  title: string;
  body: string;
  /** L3：以沙箱 iframe 渲染的插件 HTML（优先于 body 文本） */
  sandboxHtml?: string;
};

interface PluginOverlayState {
  entries: PluginOverlayEntry[];
  show: (entry: PluginOverlayEntry) => void;
  hide: (id: string) => void;
}

export const usePluginOverlayStore = create<PluginOverlayState>((set) => ({
  entries: [],
  show: (entry) =>
    set((state) => ({
      entries: [...state.entries.filter((item) => item.id !== entry.id), entry],
    })),
  hide: (id) => set((state) => ({ entries: state.entries.filter((item) => item.id !== id) })),
}));
