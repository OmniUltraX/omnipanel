// 资源档案 SubWindow 的全局打开状态。
// 任何模块（SSH 主机列表 / 数据库面板 / Docker 等）通过 openProfile() 触发，
// App.tsx 顶部挂载的 <ResourceProfileSubWindow /> 监听 openTarget 渲染窗口。

import { create } from "zustand";

export type ResourceKind = "ssh" | "database" | "docker" | "files";

export interface ResourceProfileOpenTarget {
  resourceType: ResourceKind;
  resourceId: string;
  displayName?: string;
}

interface ResourceProfileNavState {
  openTarget: ResourceProfileOpenTarget | null;
  openProfile: (target: ResourceProfileOpenTarget) => void;
  closeProfile: () => void;
}

export const useResourceProfileNavStore = create<ResourceProfileNavState>(
  (set) => ({
    openTarget: null,
    openProfile: (target) => set({ openTarget: target }),
    closeProfile: () => set({ openTarget: null }),
  }),
);
