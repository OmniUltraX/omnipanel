/**
 * 最近激活 Tab 跟踪 store —— 供 Ctrl+E「最近切换的 Tab」面板使用。
 *
 * 在各 dock 的 onDidActivePanelChange 时调用 recordActiveTab，
 * 跨模块（数据库/终端/SSH/HTTP/工作区 dock）聚合到一个按时间倒序的列表。
 */

import { create } from "zustand";

/** Tab 来源模块标识 */
export type TabSource =
  | "database"
  | "terminal"
  | "ssh"
  | "protocol"
  | "workspace-dock"
  | "workspace-bottom";

export interface ActiveTabEntry {
  /** 唯一 id（通常是 panel id） */
  id: string;
  /** 来源模块 */
  source: TabSource;
  /** 显示标题 */
  title: string;
  /** 副标题（可选，如库名.表名） */
  subtitle?: string;
  /** 激活时间戳 */
  activatedAt: number;
  /** 重新激活该 tab 的回调（dock 内部设置） */
  activate?: () => void;
  /** 关闭该 tab 的回调（可选） */
  close?: () => void;
}

const RECENT_TAB_LIMIT = 30;

interface RecentTabsState {
  /** 按时间倒序的最近激活 tab（最近在前） */
  tabs: ActiveTabEntry[];
  /** 记录/更新一个 tab 的激活 */
  recordActiveTab: (entry: Omit<ActiveTabEntry, "activatedAt"> & { activatedAt?: number }) => void;
  /** 移除一个 tab（关闭时调用） */
  removeTab: (id: string) => void;
  /** 清空某来源的所有 tab（模块卸载时） */
  removeBySource: (source: TabSource) => void;
  /** 清空 */
  clear: () => void;
}

export const useRecentTabs = create<RecentTabsState>()((set) => ({
  tabs: [],
  recordActiveTab: (entry) =>
    set((s) => {
      const now = entry.activatedAt ?? Date.now();
      const filtered = s.tabs.filter((t) => t.id !== entry.id);
      return {
        tabs: [{ ...entry, activatedAt: now }, ...filtered].slice(0, RECENT_TAB_LIMIT),
      };
    }),
  removeTab: (id) =>
    set((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) })),
  removeBySource: (source) =>
    set((s) => ({ tabs: s.tabs.filter((t) => t.source !== source) })),
  clear: () => set({ tabs: [] }),
}));

/** 获取最近激活的 tab 列表（已过滤掉无 activate 回调的，用于 Ctrl+E 可点击列表） */
export function getRecentTabs(): ActiveTabEntry[] {
  return useRecentTabs.getState().tabs.filter((t) => t.activate);
}
