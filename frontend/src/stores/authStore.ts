import { create } from "zustand";
import { persist } from "zustand/middleware";
import { logoutSession } from "../lib/auth/loginApi";
import { stopPresenceHeartbeat } from "../lib/auth/presenceHeartbeat";
import {
  cancelAssistantSnapshotSyncViaBridge,
  notifyAssistantSnapshotSync,
} from "../lib/assistantSnapshotSyncBridge";
import {
  startAssistantChatInboxViaBridge,
  startAssistantTerminalCmdInboxViaBridge,
  stopAssistantChatInboxViaBridge,
  stopAssistantTerminalCmdInboxViaBridge,
} from "../lib/assistantInboxBridge";
import { cancelClientConversationSyncViaBridge } from "../lib/clientConversationSyncBridge";
import { cancelClientModuleSyncViaBridge } from "../lib/clientModuleSyncBridge";
import { useAssistantTeamBindingStore } from "./assistantTeamBindingStore";
import { useCurrentSyncTeamStore } from "./currentSyncTeamStore";

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
        notifyAssistantSnapshotSync({ immediate: true });
        void startAssistantChatInboxViaBridge();
        void startAssistantTerminalCmdInboxViaBridge();
      },
      logout: (opts) => {
        const token = get().token?.trim() || null;
        stopPresenceHeartbeat();
        cancelAssistantSnapshotSyncViaBridge();
        cancelClientConversationSyncViaBridge();
        cancelClientModuleSyncViaBridge();
        void stopAssistantChatInboxViaBridge();
        void stopAssistantTerminalCmdInboxViaBridge();
        // 清空当前同步团队与助手组织授权表，避免下次登录串到上一个账号
        useCurrentSyncTeamStore.getState().resetCurrentSyncTeam();
        useAssistantTeamBindingStore.getState().reset();
        void import("../lib/auth/teamMesh")
          .then((m) => m.stopTeamMesh())
          .catch(() => {
            /* mesh 未启动时停止可忽略 */
          });
        void import("../lib/applyLocalTeamScope")
          .then((m) => m.applyLocalTeamScope("local", { quiet: true }))
          .catch(() => {
            /* 换回 local 目录失败不阻断登出 */
          });
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
