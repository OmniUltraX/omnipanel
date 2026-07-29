import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  cancelAssistantSnapshotSync,
  scheduleAssistantSnapshotSync,
  startAssistantChatInbox,
  stopAssistantChatInbox,
} from "../modules/assistant";
import {
  cancelClientConversationSync,
  cancelClientModuleSync,
  hydrateClientSync,
} from "../modules/clientSync";

interface AuthState {
  token: string | null;
  openid: string | null;
  setSession: (session: { token: string; openid: string }) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      openid: null,
      setSession: ({ token, openid }) => {
        set({ token, openid });
        // 登录后尽快推一次，便于助手端拿到初始快照
        scheduleAssistantSnapshotSync({ immediate: true });
        void startAssistantChatInbox();
        // 客户端间：会话 + 各模块 pull/merge（与助手快照独立）
        void hydrateClientSync();
      },
      logout: () => {
        cancelAssistantSnapshotSync();
        cancelClientConversationSync();
        cancelClientModuleSync();
        void stopAssistantChatInbox();
        set({ token: null, openid: null });
      },
    }),
    {
      name: "omnipanel-auth.v1",
      partialize: (state) => ({
        token: state.token,
        openid: state.openid,
      }),
    },
  ),
);

export function selectIsLoggedIn(state: AuthState): boolean {
  return Boolean(state.token);
}
