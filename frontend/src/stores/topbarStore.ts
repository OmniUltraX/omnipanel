import { create } from "zustand";

/** session = 可关闭终端标签；connection = 固定连接切换；segment = 固定视图分段 */
export type TopbarTabMode = "session" | "connection" | "segment";

export interface TopbarTabDef {
  id: string;
  label: string;
  active?: boolean;
  /** 仅 session 模式：是否显示关闭按钮 */
  closable?: boolean;
  /** 仅 session 模式：连接状态点 */
  status?: "connected" | "connecting" | "idle" | "online" | "offline";
  /** 仅 segment 模式：图标 key */
  icon?: "monitor" | "processes" | "services" | "logs";
  /** segment 模式：标签旁计数徽章 */
  badge?: { text: string | number; tone?: "accent" | "warn" | "danger" | "muted" | "success" };
}

export interface TopbarHandlers {
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onAdd?: () => void;
}

export interface TopbarTabOptions {
  mode?: TopbarTabMode;
  showAddTab?: boolean;
  addTabTitle?: string;
  /** 为 false 时清除顶栏标签（用于保活但隐藏的面板） */
  enabled?: boolean;
}

interface TopbarState {
  tabs: TopbarTabDef[];
  tabMode: TopbarTabMode;
  showAddTab: boolean;
  addTabTitle: string;
  handlers: TopbarHandlers;
  setTabs: (tabs: TopbarTabDef[], handlers?: TopbarHandlers, options?: TopbarTabOptions) => void;
  clearTabs: () => void;
}

export const useTopbarStore = create<TopbarState>((set) => ({
  tabs: [],
  tabMode: "session",
  showAddTab: false,
  addTabTitle: "",
  handlers: {},
  setTabs: (tabs, handlers = {}, options = {}) =>
    set({
      tabs,
      handlers,
      tabMode: options.mode ?? "session",
      showAddTab: options.showAddTab ?? false,
      addTabTitle: options.addTabTitle ?? "",
    }),
  clearTabs: () =>
    set({
      tabs: [],
      handlers: {},
      tabMode: "session",
      showAddTab: false,
      addTabTitle: "",
    }),
}));
