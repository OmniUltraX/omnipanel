import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AuthTeamMembership } from "../lib/auth/loginApi";
import { useUserProfileStore } from "./userProfileStore";

/**
 * 当前数据快照来源团队。
 *
 * - `teamId` 为 `null` 时回退到 `/api/me.teams` 中 `kind=personal` 的默认团队。
 * - 用户在侧栏头像上方的「切换团队」按钮中选择某个团队后写入该团队 id；
 *   切换流程会先把本机数据推回旧团队，再从新团队拉取并替换本机数据源。
 *   之后自动同步与手动拉取都会读写该团队 OSS 前缀。
 * - 账号切换 / 登出时由调用方 `resetCurrentSyncTeam` 清空，避免跨账号串数据。
 */
export interface CurrentSyncTeamState {
  teamId: number | null;
  setTeamId: (id: number | null) => void;
  resetCurrentSyncTeam: () => void;
}

export const useCurrentSyncTeamStore = create<CurrentSyncTeamState>()(
  persist(
    (set) => ({
      teamId: null,
      setTeamId: (id) => set({ teamId: id }),
      resetCurrentSyncTeam: () => set({ teamId: null }),
    }),
    {
      name: "omnipanel-current-sync-team.v1",
      version: 1,
      partialize: (state) => ({ teamId: state.teamId }),
    },
  ),
);

/** 在 profile.teams 中查找 `kind=personal` 的默认团队。 */
export function findPersonalTeam(teams: AuthTeamMembership[]): AuthTeamMembership | null {
  return teams.find((t) => (t.kind ?? "").trim().toLowerCase() === "personal") ?? null;
}

/**
 * 解析当前生效的同步团队 id。
 *
 * 优先使用用户在菜单里显式选择的 `currentTeamId`；否则回退到 profile 里的
 * `kind=personal` 团队；都没有则返回 `null`（调用方应让后端回退到 personal）。
 */
export function resolveCurrentSyncTeamId(
  currentTeamId: number | null,
  teams: AuthTeamMembership[],
): number | null {
  if (currentTeamId && currentTeamId > 0) return currentTeamId;
  const personal = findPersonalTeam(teams);
  return personal?.id ?? null;
}

/**
 * 取当前生效的同步团队 id（供非 React 调用方使用）。
 *
 * 返回 `null` 时调用方应传 `teamId: null/undefined` 给后端，由后端回退到 personal。
 */
export function getCurrentSyncTeamId(): number | null {
  const { teamId, teams } = (() => {
    const sync = useCurrentSyncTeamStore.getState();
    const profile = useUserProfileStore.getState();
    return { teamId: sync.teamId, teams: profile.teams };
  })();
  return resolveCurrentSyncTeamId(teamId, teams);
}
