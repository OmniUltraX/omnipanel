import { create } from "zustand";
import { persist } from "zustand/middleware";

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
      setAvatarUrl: (avatarUrl) => set({ avatarUrl }),
      setProfile: (profile) =>
        set((state) => ({
          nickname: profile.nickname ?? state.nickname,
          avatarUrl: profile.avatarUrl ?? state.avatarUrl,
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
            avatarUrl: (raw.avatarUrl ?? "").trim(),
          };
        }
        return {
          nickname: (raw.nickname ?? "").trim(),
          avatarUrl: (raw.avatarUrl ?? "").trim(),
        };
      },
      partialize: (state) => ({
        nickname: state.nickname,
        avatarUrl: state.avatarUrl,
      }),
    },
  ),
);
