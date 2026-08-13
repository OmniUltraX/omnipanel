import { create } from "zustand";

/** 从右键「分享」带入的业务载荷；null 表示仅扫描发现。 */
export type LanSharePayload = {
  kind: "custom-panel";
  panelId: string;
  label: string;
} | null;

type LanDiscoveryUiState = {
  open: boolean;
  sharePayload: LanSharePayload;
  openDialog: (payload?: LanSharePayload) => void;
  closeDialog: () => void;
};

/** 局域网发现 / 面板分享弹窗。 */
export const useLanDiscoveryUiStore = create<LanDiscoveryUiState>((set) => ({
  open: false,
  sharePayload: null,
  openDialog: (payload = null) => set({ open: true, sharePayload: payload }),
  closeDialog: () => set({ open: false, sharePayload: null }),
}));
