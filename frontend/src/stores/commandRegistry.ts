/**
 * 命令注册中心 —— 取代 CommandPalette 内硬编码的 COMMAND_DEFS。
 *
 * 设计目标：
 * 1. 模块可在挂载时自注册命令（如数据库注册"新建查询"、终端注册"新建终端"）。
 * 2. 命令面板 / Search Everywhere / Ctrl+E 共用同一命令源。
 * 3. 记录最近使用命令，供 Ctrl+E 和命令面板置顶展示。
 * 4. 与 shortcutsStore 联动：命令可声明其 shortcutId，面板自动从 store 拉取当前生效快捷键。
 */

import { create } from "zustand";
import { formatShortcutList, getShortcutKeys } from "./shortcutsStore";

/** 命令分组标识，用于面板分类展示 */
export type CommandCategory =
  | "nav" // 导航：切换到某模块
  | "action" // 动作：新建终端、新建查询等
  | "ai" // AI 相关
  | "recent" // 最近（动态注入，不在注册表里）
  | "closed"; // 最近关闭（动态注入）

export interface CommandItem {
  /** 唯一 id，用于去重和最近使用记录 */
  id: string;
  /** 显示文本（已 i18n） */
  label: string;
  /** 分类（已 i18n） */
  category: string;
  /** 关联的快捷键 id（可选，从 shortcutsStore 拉取当前生效组合） */
  shortcutId?: string;
  /** 硬编码快捷键展示文本（无 shortcutId 时使用，如 "⌘1"） */
  shortcutLabel?: string;
  /** 执行动作 */
  run: () => void;
  /** 关键词（用于模糊匹配，可选） */
  keywords?: string[];
  /** 图标（可选，SVG 节点或 name） */
  icon?: string;
  /** 来源模块（用于调试） */
  source?: string;
}

interface CommandRegistryState {
  /** 已注册命令（按 id 去重） */
  commands: Record<string, CommandItem>;
  /** 注册命令（模块挂载时调用） */
  register: (cmd: CommandItem) => void;
  /** 批量注册 */
  registerAll: (cmds: CommandItem[]) => void;
  /** 注销命令（模块卸载时调用） */
  unregister: (id: string) => void;
  /** 注销某来源的所有命令 */
  unregisterBySource: (source: string) => void;
}

export const useCommandRegistry = create<CommandRegistryState>()((set) => ({
  commands: {},
  register: (cmd) =>
    set((s) => ({ commands: { ...s.commands, [cmd.id]: cmd } })),
  registerAll: (cmds) =>
    set((s) => {
      const next = { ...s.commands };
      for (const c of cmds) next[c.id] = c;
      return { commands: next };
    }),
  unregister: (id) =>
    set((s) => {
      if (!(id in s.commands)) return s;
      const next = { ...s.commands };
      delete next[id];
      return { commands: next };
    }),
  unregisterBySource: (source) =>
    set((s) => {
      const next: Record<string, CommandItem> = {};
      let changed = false;
      for (const [id, cmd] of Object.entries(s.commands)) {
        if (cmd.source === source) {
          changed = true;
          continue;
        }
        next[id] = cmd;
      }
      return changed ? { commands: next } : s;
    }),
}));

/** 获取命令的快捷键展示文本（优先 shortcutId，回退 shortcutLabel） */
export function getCommandShortcutLabel(cmd: CommandItem): string | undefined {
  if (cmd.shortcutId) {
    const keys = getShortcutKeys(cmd.shortcutId);
    if (keys.length > 0) return formatShortcutList(keys);
  }
  return cmd.shortcutLabel;
}

/** 获取所有已注册命令的数组 */
export function getAllCommands(): CommandItem[] {
  return Object.values(useCommandRegistry.getState().commands);
}

// ─── 最近使用命令记录 ─────────────────────────────────────────────

const RECENT_COMMAND_LIMIT = 20;

interface RecentCommandsState {
  /** 按时间倒序的命令 id 列表（最近在前） */
  recentIds: string[];
  /** 记录一次命令使用 */
  recordUse: (id: string) => void;
  /** 清空 */
  clear: () => void;
}

export const useRecentCommands = create<RecentCommandsState>()(
  (set) => ({
    recentIds: [],
    recordUse: (id) =>
      set((s) => {
        const filtered = s.recentIds.filter((x) => x !== id);
        return { recentIds: [id, ...filtered].slice(0, RECENT_COMMAND_LIMIT) };
      }),
    clear: () => set({ recentIds: [] }),
  }),
);

/** 获取最近使用的命令列表（已过滤掉已注销的） */
export function getRecentCommands(): CommandItem[] {
  const registry = useCommandRegistry.getState().commands;
  const ids = useRecentCommands.getState().recentIds;
  const out: CommandItem[] = [];
  for (const id of ids) {
    const cmd = registry[id];
    if (cmd) out.push(cmd);
  }
  return out;
}
