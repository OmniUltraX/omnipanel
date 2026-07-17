import { create } from "zustand";
import { persist } from "zustand/middleware";

type State = {
  /** 用户开启过系统监控的 SSH 连接 ID（跨刷新 / 重启保留） */
  enabledIds: string[];
  remember: (resourceId: string) => void;
  forget: (resourceId: string) => void;
  has: (resourceId: string) => boolean;
};

/** 仅持久化「监控开关」偏好；曲线与订阅会话不落盘。 */
export const useSshMonitoringPrefsStore = create<State>()(
  persist(
    (set, get) => ({
      enabledIds: [],
      remember: (resourceId) =>
        set((state) =>
          state.enabledIds.includes(resourceId)
            ? state
            : { enabledIds: [...state.enabledIds, resourceId] },
        ),
      forget: (resourceId) =>
        set((state) => ({
          enabledIds: state.enabledIds.filter((id) => id !== resourceId),
        })),
      has: (resourceId) => get().enabledIds.includes(resourceId),
    }),
    {
      name: "omnipanel.ssh.monitoring-enabled",
      partialize: (state) => ({ enabledIds: state.enabledIds }),
    },
  ),
);
