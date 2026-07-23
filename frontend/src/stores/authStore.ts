import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  cancelAssistantSnapshotSync,
  scheduleAssistantSnapshotSync,
} from "../modules/assistant";

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
      },
      logout: () => {
        cancelAssistantSnapshotSync();
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
