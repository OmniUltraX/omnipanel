import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  getDefaultResourceForPath,
  getResourceById,
  type EnvironmentTag,
  type WorkspaceResource,
} from "../lib/resourceRegistry";

export interface WorkspaceInfo {
  id: string;
  name: string;
  description: string;
}

export interface WorkspaceContextSnapshot {
  workspace: WorkspaceInfo;
  activePath: string;
  activeResource: WorkspaceResource | null;
  environment: EnvironmentTag;
  riskLevel: "low" | "medium" | "high" | "critical";
  updatedAt: number;
}

interface WorkspaceState {
  workspace: WorkspaceInfo;
  activePath: string;
  activeResourceId: string | null;
  selectedResourceByPath: Record<string, string>;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;

  setActivePath: (path: string) => void;
  selectResource: (resourceId: string) => void;
  setRightPanelOpen: (open: boolean) => void;
  setBottomPanelOpen: (open: boolean) => void;
  getActiveResource: () => WorkspaceResource | null;
  getSnapshot: () => WorkspaceContextSnapshot;
}

function environmentToRisk(environment: EnvironmentTag): WorkspaceContextSnapshot["riskLevel"] {
  if (environment === "prod") return "high";
  if (environment === "staging") return "medium";
  return "low";
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspace: {
        id: "default",
        name: "默认工程工作区",
        description: "本地终端、远程主机、数据库、容器与协议调试的统一上下文",
      },
      activePath: "/",
      activeResourceId: "local-terminal",
      selectedResourceByPath: {},
      rightPanelOpen: true,
      bottomPanelOpen: true,

      setActivePath: (path) =>
        set((state) => {
          const remembered = state.selectedResourceByPath[path];
          const fallback = getDefaultResourceForPath(path);
          const activeResourceId = remembered ?? fallback?.id ?? state.activeResourceId;
          return { activePath: path, activeResourceId };
        }),

      selectResource: (resourceId) =>
        set((state) => {
          const resource = getResourceById(resourceId);
          if (!resource) return state;
          return {
            activeResourceId: resourceId,
            selectedResourceByPath: {
              ...state.selectedResourceByPath,
              [resource.modulePath]: resourceId,
            },
          };
        }),

      setRightPanelOpen: (open) => set({ rightPanelOpen: open }),
      setBottomPanelOpen: (open) => set({ bottomPanelOpen: open }),

      getActiveResource: () => getResourceById(get().activeResourceId),

      getSnapshot: () => {
        const state = get();
        const activeResource = getResourceById(state.activeResourceId);
        const environment = activeResource?.environment ?? "unknown";
        return {
          workspace: state.workspace,
          activePath: state.activePath,
          activeResource,
          environment,
          riskLevel: environmentToRisk(environment),
          updatedAt: Date.now(),
        };
      },
    }),
    {
      name: "omnipanel-workspace-store",
      partialize: (state) => ({
        workspace: state.workspace,
        activePath: state.activePath,
        activeResourceId: state.activeResourceId,
        selectedResourceByPath: state.selectedResourceByPath,
        rightPanelOpen: state.rightPanelOpen,
        bottomPanelOpen: state.bottomPanelOpen,
      }),
    }
  )
);
