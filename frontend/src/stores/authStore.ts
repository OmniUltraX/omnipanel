import { create } from "zustand";
import { persist } from "zustand/middleware";

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
      setSession: ({ token, openid }) => set({ token, openid }),
      logout: () => set({ token: null, openid: null }),
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
