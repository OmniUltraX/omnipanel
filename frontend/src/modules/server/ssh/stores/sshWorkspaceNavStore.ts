import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createSafeLocalStorage } from "../../../../lib/zustandPersistStorage";

export type SshWorkspaceSection = "hosts" | "tunnels" | "keys";

type State = {
  section: SshWorkspaceSection;
  activeTunnelId: string | null;
  activeKeyName: string | null;
  setSection: (section: SshWorkspaceSection) => void;
  selectTunnel: (tunnelId: string | null) => void;
  selectKey: (keyName: string | null) => void;
  selectHost: () => void;
};

export const useSshWorkspaceNavStore = create<State>()(
  persist(
    (set) => ({
      section: "hosts",
      activeTunnelId: null,
      activeKeyName: null,
      setSection: (section) => set({ section }),
      selectTunnel: (activeTunnelId) => set({ activeTunnelId }),
      selectKey: (activeKeyName) => set({ activeKeyName }),
      selectHost: () => set({ section: "hosts", activeTunnelId: null, activeKeyName: null }),
    }),
    {
      name: "omnipanel-ssh-workspace-nav",
      storage: createJSONStorage(createSafeLocalStorage),
    },
  ),
);
