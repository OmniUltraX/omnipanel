import { create } from "zustand";
import { persist } from "zustand/middleware";
import { logoutSession } from "../lib/auth/loginApi";
import { stopPresenceHeartbeat } from "../lib/auth/presenceHeartbeat";
import {
  cancelAssistantSnapshotSync,
  scheduleAssistantSnapshotSync,
  startAssistantChatInbox,
  stopAssistantChatInbox,
  startAssistantTerminalCmdInbox,
  stopAssistantTerminalCmdInbox,
} from "../modules/assistant";
import {
  cancelClientConversationSync,
  cancelClientModuleSync,
} from "../modules/clientSync";

interface AuthState {
  token: string | null;
  openid: string | null;
  setSession: (session: { token: string; openid: string }) => void;
  /** skipRemote：本地已判定会话失效时，跳过再调服务端 logout。 */
  logout: (opts?: { skipRemote?: boolean }) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      openid: null,
      setSession: ({ token, openid }) => {
        set({ token, openid });
        // 登录后尽快推一次，便于助手端拿到初始快照
        scheduleAssistantSnapshotSync({ immediate: true });
        void startAssistantChatInbox();
        void startAssistantTerminalCmdInbox();
      },
      logout: (opts) => {
        const token = get().token?.trim() || null;
        stopPresenceHeartbeat();
        cancelAssistantSnapshotSync();
        cancelClientConversationSync();
        cancelClientModuleSync();
        void stopAssistantChatInbox();
        void stopAssistantTerminalCmdInbox();
        if (token && !opts?.skipRemote) {
          void logoutSession(token).catch(() => {
            /* 退出时网络失败可忽略，本地会话照样清掉 */
          });
        }
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
