import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 某组织下已接收同步密钥的助手端（本机视角）。 */
export type AssistantTeamBinding = {
  deviceId: string;
  deviceName: string;
  appId: string;
};

type State = {
  /** teamId → 该组织已授权的助手设备 */
  byTeam: Record<string, AssistantTeamBinding[]>;
  markBound: (teamId: number, device: AssistantTeamBinding) => void;
  unbind: (teamId: number, deviceId: string) => void;
  listForTeam: (teamId: number) => AssistantTeamBinding[];
  reset: () => void;
};

function teamKey(teamId: number): string {
  return String(teamId);
}

/**
 * 助手端 ↔ 组织密钥的本机绑定表。
 *
 * 账号级「设备列表」不含组织维度；助手可对多个组织分别扫码收钥，
 * 侧栏「绑定助手」需按当前同步组织展示，故在本机按 teamId 分桶记录。
 */
export const useAssistantTeamBindingStore = create<State>()(
  persist(
    (set, get) => ({
      byTeam: {},
      markBound: (teamId, device) => {
        if (!Number.isFinite(teamId) || teamId <= 0) return;
        const id = device.deviceId.trim();
        if (!id) return;
        const key = teamKey(teamId);
        set((state) => {
          const prev = state.byTeam[key] ?? [];
          const nextItem: AssistantTeamBinding = {
            deviceId: id,
            deviceName: device.deviceName.trim(),
            appId: device.appId.trim(),
          };
          const idx = prev.findIndex((d) => d.deviceId === id);
          const next =
            idx >= 0
              ? prev.map((d, i) => (i === idx ? { ...d, ...nextItem } : d))
              : [...prev, nextItem];
          return { byTeam: { ...state.byTeam, [key]: next } };
        });
      },
      unbind: (teamId, deviceId) => {
        if (!Number.isFinite(teamId) || teamId <= 0) return;
        const id = deviceId.trim();
        if (!id) return;
        const key = teamKey(teamId);
        set((state) => {
          const prev = state.byTeam[key] ?? [];
          const next = prev.filter((d) => d.deviceId !== id);
          if (next.length === prev.length) return state;
          const byTeam = { ...state.byTeam };
          if (next.length === 0) {
            delete byTeam[key];
          } else {
            byTeam[key] = next;
          }
          return { byTeam };
        });
      },
      listForTeam: (teamId) => {
        if (!Number.isFinite(teamId) || teamId <= 0) return [];
        return get().byTeam[teamKey(teamId)] ?? [];
      },
      reset: () => set({ byTeam: {} }),
    }),
    {
      name: "omnipanel-assistant-team-bindings.v1",
      version: 1,
      partialize: (state) => ({ byTeam: state.byTeam }),
    },
  ),
);
