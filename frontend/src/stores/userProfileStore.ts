import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UserProfileState {
  displayName: string;
  setDisplayName: (name: string) => void;
}

export const useUserProfileStore = create<UserProfileState>()(
  persist(
    (set) => ({
      displayName: "",
      setDisplayName: (displayName) => set({ displayName }),
    }),
    {
      name: "omnipanel-user-profile.v1",
    },
  ),
);
