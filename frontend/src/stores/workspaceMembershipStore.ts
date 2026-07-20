import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 工作区可选资源 membership（未列入 = 不限制，全局可用） */
interface WorkspaceMembershipState {
  /** workspaceId → resource ids（SSH/DB/Docker/files 连接 id） */
  resourceIdsByWorkspace: Record<string, string[]>;
  setWorkspaceResources: (workspaceId: string, resourceIds: string[]) => void;
  addWorkspaceResources: (workspaceId: string, resourceIds: string[]) => void;
  removeWorkspaceResources: (workspaceId: string, resourceIds: string[]) => void;
  getWorkspaceResourceIds: (workspaceId: string) => string[];
}

export const useWorkspaceMembershipStore = create<WorkspaceMembershipState>()(
  persist(
    (set, get) => ({
      resourceIdsByWorkspace: {},
      setWorkspaceResources: (workspaceId, resourceIds) =>
        set((s) => ({
          resourceIdsByWorkspace: {
            ...s.resourceIdsByWorkspace,
            [workspaceId]: [...new Set(resourceIds)],
          },
        })),
      addWorkspaceResources: (workspaceId, resourceIds) =>
        set((s) => {
          const prev = s.resourceIdsByWorkspace[workspaceId] ?? [];
          return {
            resourceIdsByWorkspace: {
              ...s.resourceIdsByWorkspace,
              [workspaceId]: [...new Set([...prev, ...resourceIds])],
            },
          };
        }),
      removeWorkspaceResources: (workspaceId, resourceIds) =>
        set((s) => {
          const remove = new Set(resourceIds);
          const prev = s.resourceIdsByWorkspace[workspaceId] ?? [];
          return {
            resourceIdsByWorkspace: {
              ...s.resourceIdsByWorkspace,
              [workspaceId]: prev.filter((id) => !remove.has(id)),
            },
          };
        }),
      getWorkspaceResourceIds: (workspaceId) =>
        get().resourceIdsByWorkspace[workspaceId] ?? [],
    }),
    { name: "omnipanel-workspace-membership" },
  ),
);
