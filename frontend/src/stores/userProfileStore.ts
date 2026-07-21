import { create } from "zustand";
import { persist } from "zustand/middleware";
import { resolveAvatarUrl } from "../lib/auth/loginApi";

export interface UserProfileState {
  nickname: string;
  avatarUrl: string;
  setNickname: (nickname: string) => void;
  setAvatarUrl: (avatarUrl: string) => void;
  setProfile: (profile: { nickname?: string; avatarUrl?: string }) => void;
  clearProfile: () => void;
}

type PersistedProfileV1 = {
  displayName?: string;
  nickname?: string;
  avatarUrl?: string;
};

export const useUserProfileStore = create<UserProfileState>()(
  persist(
    (set) => ({
      nickname: "",
      avatarUrl: "",
      setNickname: (nickname) => set({ nickname }),
      setAvatarUrl: (avatarUrl) => set({ avatarUrl: resolveAvatarUrl(avatarUrl) }),
      setProfile: (profile) =>
        set((state) => ({
          nickname: profile.nickname ?? state.nickname,
          avatarUrl:
            profile.avatarUrl !== undefined
              ? resolveAvatarUrl(profile.avatarUrl)
              : state.avatarUrl,
        })),
      clearProfile: () => set({ nickname: "", avatarUrl: "" }),
    }),
    {
      name: "omnipanel-user-profile.v1",
      version: 2,
      migrate: (persisted, fromVersion) => {
        const raw = (persisted ?? {}) as PersistedProfileV1;
        if (fromVersion < 2) {
          return {
            nickname: (raw.nickname ?? raw.displayName ?? "").trim(),
            avatarUrl: resolveAvatarUrl(raw.avatarUrl ?? ""),
          };
        }
        return {
          nickname: (raw.nickname ?? "").trim(),
          avatarUrl: resolveAvatarUrl(raw.avatarUrl ?? ""),
        };
      },
      partialize: (state) => ({
        nickname: state.nickname,
        avatarUrl: state.avatarUrl,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.avatarUrl = resolveAvatarUrl(state.avatarUrl);
      },
    },
  ),
);
