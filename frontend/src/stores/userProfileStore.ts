import { create } from "zustand";
import { persist } from "zustand/middleware";
import { resolveAvatarUrl } from "../lib/auth/loginApi";

export interface UserProfileState {
  nickname: string;
  avatarUrl: string;
  /** 微信 openid；非空视为已绑定微信 */
  openid: string;
  email: string;
  githubId: string;
  setNickname: (nickname: string) => void;
  setAvatarUrl: (avatarUrl: string) => void;
  setProfile: (profile: {
    nickname?: string;
    avatarUrl?: string;
    openid?: string;
    email?: string;
    githubId?: string;
  }) => void;
  clearProfile: () => void;
}

type PersistedProfileV1 = {
  displayName?: string;
  nickname?: string;
  avatarUrl?: string;
  openid?: string;
  email?: string;
  githubId?: string;
};

export const useUserProfileStore = create<UserProfileState>()(
  persist(
    (set) => ({
      nickname: "",
      avatarUrl: "",
      openid: "",
      email: "",
      githubId: "",
      setNickname: (nickname) => set({ nickname }),
      setAvatarUrl: (avatarUrl) => set({ avatarUrl: resolveAvatarUrl(avatarUrl) }),
      setProfile: (profile) =>
        set((state) => ({
          nickname: profile.nickname ?? state.nickname,
          avatarUrl:
            profile.avatarUrl !== undefined
              ? resolveAvatarUrl(profile.avatarUrl)
              : state.avatarUrl,
          openid: profile.openid !== undefined ? profile.openid : state.openid,
          email: profile.email !== undefined ? profile.email : state.email,
          githubId: profile.githubId !== undefined ? profile.githubId : state.githubId,
        })),
      clearProfile: () =>
        set({ nickname: "", avatarUrl: "", openid: "", email: "", githubId: "" }),
    }),
    {
      name: "omnipanel-user-profile.v1",
      version: 3,
      migrate: (persisted, fromVersion) => {
        const raw = (persisted ?? {}) as PersistedProfileV1;
        if (fromVersion < 2) {
          return {
            nickname: (raw.nickname ?? raw.displayName ?? "").trim(),
            avatarUrl: resolveAvatarUrl(raw.avatarUrl ?? ""),
            openid: "",
            email: "",
            githubId: "",
          };
        }
        return {
          nickname: (raw.nickname ?? "").trim(),
          avatarUrl: resolveAvatarUrl(raw.avatarUrl ?? ""),
          openid: fromVersion < 3 ? "" : (raw.openid ?? "").trim(),
          email: fromVersion < 3 ? "" : (raw.email ?? "").trim(),
          githubId: fromVersion < 3 ? "" : (raw.githubId ?? "").trim(),
        };
      },
      partialize: (state) => ({
        nickname: state.nickname,
        avatarUrl: state.avatarUrl,
        openid: state.openid,
        email: state.email,
        githubId: state.githubId,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.avatarUrl = resolveAvatarUrl(state.avatarUrl);
      },
    },
  ),
);

/** 是否已绑定微信（助手端绑定前置条件）。 */
export function selectWechatBound(state: UserProfileState): boolean {
  return Boolean(state.openid.trim());
}
