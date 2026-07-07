import { create } from "zustand";
import type { DockerContainerSummary } from "../../ipc/bindings";

export interface DashboardContainerState {
  /** 最近一次成功拉取的容器列表（去重后） */
  containers: DockerContainerSummary[];
  /** 是否正在拉取 */
  loading: boolean;
  /** 拉取失败的次数（仅用于提示，不影响重试） */
  failureCount: number;
  /** 最近一次拉取完成的 epoch ms（用于判断 stale-while-revalidate） */
  lastUpdatedAt: number;
}

interface DashboardState extends DashboardContainerState {
  /** 触发刷新的递增信号；HomeBoardView 订阅后重新拉数据 */
  refreshSignal: number;
  /** 调用即自增 refreshSignal，HomeBoardView 拉数据 */
  triggerRefresh: () => void;
  /** 直接写入容器拉取结果（useDashboardData 内部调用） */
  setContainerSnapshot: (snapshot: {
    containers: DockerContainerSummary[];
    loading: boolean;
    failureCount: number;
  }) => void;
  /** 重置失败计数（拉取成功时） */
  clearFailure: () => void;
}

const EMPTY: DashboardContainerState = {
  containers: [],
  loading: true,
  failureCount: 0,
  lastUpdatedAt: 0,
};

export const useDashboardStore = create<DashboardState>((set) => ({
  ...EMPTY,
  refreshSignal: 0,
  triggerRefresh: () =>
    set((state) => ({ refreshSignal: state.refreshSignal + 1 })),
  setContainerSnapshot: ({ containers, loading, failureCount }) =>
    set((prev) => ({
      containers,
      loading,
      failureCount: prev.failureCount + failureCount,
      lastUpdatedAt: Date.now(),
    })),
  clearFailure: () => set({ failureCount: 0 }),
}));

/** 纯读容器快照（无订阅），给非组件上下文用 */
export function getDashboardContainerSnapshot(): DashboardContainerState {
  const s = useDashboardStore.getState();
  return {
    containers: s.containers,
    loading: s.loading,
    failureCount: s.failureCount,
    lastUpdatedAt: s.lastUpdatedAt,
  };
}
