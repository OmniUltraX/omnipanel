import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  getDefaultResourceForPath,
  type EnvironmentTag,
  type WorkspaceResource,
} from "../lib/resourceRegistry";
import { resolveResourceById } from "./connectionStore";
import { DASHBOARD_PATH } from "../lib/paths";

export interface WorkspaceInfo {
  id: string;
  name: string;
  description: string;
  /** 工作区窗口形式：embedded=内嵌主窗口, windowed=独立窗口 */
  windowForm?: "embedded" | "windowed";
  /** 独立窗口上次的位置和大小（物理像素） */
  windowBounds?: { x: number; y: number; width: number; height: number };
}

export interface WorkspaceContextSnapshot {
  workspace: WorkspaceInfo;
  activePath: string;
  activeResource: WorkspaceResource | null;
  environment: EnvironmentTag;
  riskLevel: "low" | "medium" | "high" | "critical";
  updatedAt: number;
}

export const DEFAULT_WORKSPACE: WorkspaceInfo = {
  id: "default",
  name: "默认工程工作区",
  description: "本地终端、远程主机、数据库、容器与协议调试的统一上下文",
};

/** 工作区切换事件（模块监听此事件来保存/恢复 tab 快照） */
export interface WorkspaceSwitchEvent {
  prevWorkspaceId: string;
  nextWorkspaceId: string;
}

const WORKSPACE_SWITCH_EVENT = "omnipanel:workspace-switched";

export function onWorkspaceSwitch(
  handler: (e: WorkspaceSwitchEvent) => void,
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<WorkspaceSwitchEvent>).detail);
  window.addEventListener(WORKSPACE_SWITCH_EVENT, listener);
  return () => window.removeEventListener(WORKSPACE_SWITCH_EVENT, listener);
}

interface WorkspaceState {
  /** 当前激活工作区（保留以兼容旧调用方） */
  workspace: WorkspaceInfo;
  /** 全部工作区列表 */
  workspaces: WorkspaceInfo[];
  activePath: string;
  activeResourceId: string | null;
  selectedResourceByPath: Record<string, string>;

  setActivePath: (path: string) => void;
  selectResource: (resourceId: string, contextPath?: string) => void;
  getResourceForPath: (path: string) => WorkspaceResource | null;
  getActiveResource: () => WorkspaceResource | null;
  getSnapshot: () => WorkspaceContextSnapshot;
  /**
   * 新建工作区并切换到该工作区。
   * 名称为空时直接返回当前工作区（不会创建）。
   */
  addWorkspace: (name: string, description?: string) => WorkspaceInfo;
  /** 切换到已存在的工作区；找不到时返回 false。 */
  switchWorkspace: (id: string) => boolean;
  /** 删除工作区；至少保留一个时返回 false。 */
  removeWorkspace: (id: string) => boolean;
  /** 重命名工作区；名称为空或重复时返回 false。 */
  renameWorkspace: (id: string, name: string) => boolean;
  /** 设置工作区窗口形式（embedded/windowed） */
  setWorkspaceWindowForm: (workspaceId: string, form: "embedded" | "windowed") => void;
  /** 记录工作区独立窗口的位置和大小 */
  setWorkspaceBounds: (workspaceId: string, bounds: { x: number; y: number; width: number; height: number }) => void;
}

function environmentToRisk(environment: EnvironmentTag): WorkspaceContextSnapshot["riskLevel"] {
  if (environment === "prod") return "high";
  if (environment === "staging") return "medium";
  return "low";
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      workspace: DEFAULT_WORKSPACE,
      workspaces: [DEFAULT_WORKSPACE],
      activePath: DASHBOARD_PATH,
      activeResourceId: "local-terminal",
      selectedResourceByPath: {},

      setActivePath: (path) =>
        set((state) => {
          const remembered = state.selectedResourceByPath[path];
          const fallback = getDefaultResourceForPath(path);
          const activeResourceId = remembered ?? fallback?.id ?? state.activeResourceId;
          return { activePath: path, activeResourceId };
        }),

      selectResource: (resourceId, contextPath) =>
        set((state) => {
          const pathKey = contextPath ?? state.activePath;
          return {
            activeResourceId: resourceId,
            selectedResourceByPath: {
              ...state.selectedResourceByPath,
              [pathKey]: resourceId,
            },
          };
        }),

      getResourceForPath: (path) => {
        const state = get();
        const remembered = state.selectedResourceByPath[path];
        if (remembered) {
          return resolveResourceById(remembered);
        }
        return getDefaultResourceForPath(path);
      },

      getActiveResource: () => resolveResourceById(get().activeResourceId),

      getSnapshot: () => {
        const state = get();
        const activeResource = resolveResourceById(state.activeResourceId);
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

      addWorkspace: (name, description) => {
        const trimmed = name.trim();
        if (!trimmed) {
          return get().workspace;
        }
        const newWorkspace: WorkspaceInfo = {
          id: `workspace-${Date.now()}`,
          name: trimmed,
          description: description?.trim() ?? "",
        };
        const prevId = get().workspace.id;
        set((state) => ({
          workspaces: [...state.workspaces, newWorkspace],
          workspace: newWorkspace,
        }));
        // 触发切换事件，让各模块保存/恢复 tab
        window.dispatchEvent(
          new CustomEvent<WorkspaceSwitchEvent>(WORKSPACE_SWITCH_EVENT, {
            detail: { prevWorkspaceId: prevId, nextWorkspaceId: newWorkspace.id },
          }),
        );
        return newWorkspace;
      },

      switchWorkspace: (id) => {
        const state = get();
        const target = state.workspaces.find((w) => w.id === id);
        if (!target) return false;
        const prevId = state.workspace.id;
        set({ workspace: target });
        if (prevId !== id) {
          window.dispatchEvent(
            new CustomEvent<WorkspaceSwitchEvent>(WORKSPACE_SWITCH_EVENT, {
              detail: { prevWorkspaceId: prevId, nextWorkspaceId: id },
            }),
          );
        }
        // 如果目标工作区已弹出为独立窗口，聚焦它
        if (target.windowForm === "windowed") {
          void (async () => {
            try {
              const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
              const { workspaceWindowLabel } = await import("../lib/workspaceWindow");
              const win = await WebviewWindow.getByLabel(workspaceWindowLabel(id));
              if (win) {
                await win.unminimize();
                await win.show();
                await win.setFocus();
              }
            } catch {
              // ignore
            }
          })();
        }
        return true;
      },

      removeWorkspace: (id) => {
        const state = get();
        if (state.workspaces.length <= 1) return false;
        const index = state.workspaces.findIndex((w) => w.id === id);
        if (index < 0) return false;
        const nextWorkspaces = state.workspaces.filter((w) => w.id !== id);
        const nextWorkspace =
          state.workspace.id === id
            ? nextWorkspaces[Math.min(index, nextWorkspaces.length - 1)]
            : state.workspace;
        const prevId = state.workspace.id;
        set({
          workspaces: nextWorkspaces,
          workspace: nextWorkspace,
        });
        // 如果当前工作区被删除，触发切换事件
        if (prevId === id && prevId !== nextWorkspace.id) {
          window.dispatchEvent(
            new CustomEvent<WorkspaceSwitchEvent>(WORKSPACE_SWITCH_EVENT, {
              detail: { prevWorkspaceId: prevId, nextWorkspaceId: nextWorkspace.id },
            }),
          );
        }
        // 同时清理该工作区的 tab 快照
        return true;
      },

      renameWorkspace: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return false;
        const state = get();
        const target = state.workspaces.find((w) => w.id === id);
        if (!target) return false;
        if (state.workspaces.some((w) => w.id !== id && w.name === trimmed)) return false;
        const nextWorkspaces = state.workspaces.map((w) =>
          w.id === id ? { ...w, name: trimmed } : w,
        );
        const nextWorkspace =
          state.workspace.id === id ? { ...state.workspace, name: trimmed } : state.workspace;
        set({ workspaces: nextWorkspaces, workspace: nextWorkspace });
        return true;
      },

      setWorkspaceWindowForm: (workspaceId, form) =>
        set((state) => {
          const workspaces = state.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, windowForm: form } : w,
          );
          const workspace =
            state.workspace.id === workspaceId
              ? { ...state.workspace, windowForm: form }
              : state.workspace;
          return { workspaces, workspace };
        }),

      setWorkspaceBounds: (workspaceId, bounds) =>
        set((state) => {
          const workspaces = state.workspaces.map((w) =>
            w.id === workspaceId ? { ...w, windowBounds: bounds } : w,
          );
          const workspace =
            state.workspace.id === workspaceId
              ? { ...state.workspace, windowBounds: bounds }
              : state.workspace;
          return { workspaces, workspace };
        }),
    }),
    {
      name: "omnipanel-workspace-store",
      partialize: (state) => ({
        workspace: state.workspace,
        workspaces: state.workspaces,
        activePath: state.activePath,
        activeResourceId: state.activeResourceId,
        selectedResourceByPath: state.selectedResourceByPath,
      }),
    }
  )
);
