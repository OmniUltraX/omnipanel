import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiFollowState {
  /** 默认开启：AI 工具执行时左侧跟随跳转 */
  followAiActions: boolean;
  setFollowAiActions: (enabled: boolean) => void;
  toggleFollowAiActions: () => void;
}

export const useUiFollowStore = create<UiFollowState>()(
  persist(
    (set) => ({
      followAiActions: true,
      setFollowAiActions: (enabled) => set({ followAiActions: enabled }),
      toggleFollowAiActions: () => set((s) => ({ followAiActions: !s.followAiActions })),
    }),
    { name: "omnipanel-ai-ui-follow" },
  ),
);

export function isFollowAiActionsEnabled(): boolean {
  return useUiFollowStore.getState().followAiActions;
}
