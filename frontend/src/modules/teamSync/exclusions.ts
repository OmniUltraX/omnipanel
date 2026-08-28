import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createSafeLocalStorage } from "../../lib/zustandPersistStorage";

export type TeamSyncModuleKey =
  | "connections"
  | "databases"
  | "knowledge"
  | "http"
  | "workspaces"
  | "customPanels";

type TeamSyncExclusionKind =
  | "connections"
  | "databases"
  | "knowledge"
  | "httpCollection"
  | "httpRequest"
  | "workspaces"
  | "customPanels";

export type TeamSyncExclusionPayload = {
  excludedConnections: string[];
  excludedDatabases: string[];
  excludedKnowledge: string[];
  excludedHttpRequests: string[];
  excludedHttpCollections: string[];
  excludedWorkspaces: string[];
  excludedCustomPanels: string[];
};

function keyOf(teamId: number, kind: TeamSyncExclusionKind, itemId: string): string {
  return `${teamId}:${kind}:${itemId.trim()}`;
}

function parseKey(
  key: string,
): { teamId: number; kind: TeamSyncExclusionKind; itemId: string } | null {
  const parts = key.split(":");
  if (parts.length < 3) return null;
  const teamId = Number(parts[0]);
  if (!Number.isFinite(teamId) || teamId <= 0) return null;
  const kind = parts[1] as TeamSyncExclusionKind;
  const itemId = parts.slice(2).join(":");
  if (!itemId.trim()) return null;
  return { teamId, kind, itemId };
}

function exclusionKindForItem(
  moduleKey: TeamSyncModuleKey,
  itemKind: string,
): TeamSyncExclusionKind {
  if (moduleKey === "http") {
    return itemKind === "folder" ? "httpCollection" : "httpRequest";
  }
  return moduleKey;
}

interface TeamSyncExclusionState {
  excluded: Record<string, number>;
  markExcluded: (teamId: number, kind: TeamSyncExclusionKind, itemId: string) => void;
  clearExcluded: (teamId: number, kind: TeamSyncExclusionKind, itemId: string) => void;
  isItemExcluded: (
    teamId: number,
    moduleKey: TeamSyncModuleKey,
    itemId: string,
    itemKind: string,
  ) => boolean;
  payloadForTeam: (teamId: number) => TeamSyncExclusionPayload;
}

export const useTeamSyncExclusionStore = create<TeamSyncExclusionState>()(
  persist(
    (set, get) => ({
      excluded: {},
      markExcluded: (teamId, kind, itemId) => {
        const trimmed = itemId.trim();
        if (!trimmed) return;
        set((state) => ({
          excluded: {
            ...state.excluded,
            [keyOf(teamId, kind, trimmed)]: Date.now(),
          },
        }));
      },
      clearExcluded: (teamId, kind, itemId) => {
        const trimmed = itemId.trim();
        if (!trimmed) return;
        const k = keyOf(teamId, kind, trimmed);
        set((state) => {
          if (!(k in state.excluded)) return state;
          const next = { ...state.excluded };
          delete next[k];
          return { excluded: next };
        });
      },
      isItemExcluded: (teamId, moduleKey, itemId, itemKind) => {
        const trimmed = itemId.trim();
        if (!trimmed) return false;
        const kind = exclusionKindForItem(moduleKey, itemKind);
        return keyOf(teamId, kind, trimmed) in get().excluded;
      },
      payloadForTeam: (teamId) => {
        const connections: string[] = [];
        const databases: string[] = [];
        const knowledge: string[] = [];
        const httpRequests: string[] = [];
        const httpCollections: string[] = [];
        const workspaces: string[] = [];
        const customPanels: string[] = [];

        for (const key of Object.keys(get().excluded)) {
          const parsed = parseKey(key);
          if (!parsed || parsed.teamId !== teamId) continue;
          switch (parsed.kind) {
            case "connections":
              connections.push(parsed.itemId);
              break;
            case "databases":
              databases.push(parsed.itemId);
              break;
            case "knowledge":
              knowledge.push(parsed.itemId);
              break;
            case "httpRequest":
              httpRequests.push(parsed.itemId);
              break;
            case "httpCollection":
              httpCollections.push(parsed.itemId);
              break;
            case "workspaces":
              workspaces.push(parsed.itemId);
              break;
            case "customPanels":
              customPanels.push(parsed.itemId);
              break;
            default:
              break;
          }
        }

        return {
          excludedConnections: connections,
          excludedDatabases: databases,
          excludedKnowledge: knowledge,
          excludedHttpRequests: httpRequests,
          excludedHttpCollections: httpCollections,
          excludedWorkspaces: workspaces,
          excludedCustomPanels: customPanels,
        };
      },
    }),
    {
      name: "omnipanel-team-sync-exclusions.v1",
      storage: createJSONStorage(createSafeLocalStorage),
      partialize: (state) => ({ excluded: state.excluded }),
    },
  ),
);

export function markTeamSyncExcluded(
  teamId: number,
  moduleKey: TeamSyncModuleKey,
  itemId: string,
  itemKind: string,
): void {
  const kind = exclusionKindForItem(moduleKey, itemKind);
  useTeamSyncExclusionStore.getState().markExcluded(teamId, kind, itemId);
}

export function clearTeamSyncExcluded(
  teamId: number,
  moduleKey: TeamSyncModuleKey,
  itemId: string,
  itemKind: string,
): void {
  const kind = exclusionKindForItem(moduleKey, itemKind);
  useTeamSyncExclusionStore.getState().clearExcluded(teamId, kind, itemId);
}

export function teamSyncExclusionsForIpc(teamId: number): TeamSyncExclusionPayload {
  return useTeamSyncExclusionStore.getState().payloadForTeam(teamId);
}
