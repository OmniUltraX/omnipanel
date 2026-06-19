import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isMacOS, modKeyLabel } from "../lib/platform";

/**
 * 规范化快捷键令牌：
 * - "Mod" / "Shift" / "Alt"  → 修饰键（Mod 在 macOS 上表示 ⌘，其它平台表示 Ctrl）
 * - 其它字符串                → 主按键，使用 KeyboardEvent.code / KeyboardEvent.key 的值
 */
export type KeyToken = "Mod" | "Shift" | "Alt" | string;

/** 快捷键在设置页中的模块分类 */
export type ShortcutCategory = "general" | "tabs" | "terminal" | "ssh" | "ai" | "workspace";

/** 设置页快捷键折叠面板的显示顺序 */
export const SHORTCUT_CATEGORY_ORDER: ShortcutCategory[] = [
  "general",
  "tabs",
  "terminal",
  "ssh",
  "ai",
  "workspace",
];

/** 单个可配置的快捷键定义 */
export interface ShortcutDef {
  id: string;
  /** 设置页模块分类 */
  category: ShortcutCategory;
  /** i18n 标签 key */
  labelKey: string;
  /** i18n 描述 key（可选） */
  descKey?: string;
  /** 默认按键组合 */
  defaultKeys: KeyToken[];
  /**
   * 该条目是否支持录制（如 "1-9" 这种占位表达无法用单一组合表示，标记为只读）
   */
  nonRecordable?: boolean;
}

/** 内置的快捷键定义。新增条目时同步加进两端 i18n。 */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: "command-palette", category: "general", labelKey: "settings.keybindings.items.commandPalette", defaultKeys: ["Mod", "K"] },
  { id: "open-settings", category: "general", labelKey: "settings.keybindings.items.openSettings", defaultKeys: ["Mod", ","] },
  { id: "close-tab", category: "tabs", labelKey: "settings.keybindings.items.closeTab", defaultKeys: ["Mod", "W"] },
  { id: "switch-tab", category: "tabs", labelKey: "settings.keybindings.items.switchTab", defaultKeys: ["Mod", "Tab"] },
  { id: "switch-nth-tab", category: "tabs", labelKey: "settings.keybindings.items.switchNthTab", defaultKeys: ["Mod", "1-9"], nonRecordable: true },
  { id: "new-terminal", category: "terminal", labelKey: "settings.keybindings.items.newTerminal", defaultKeys: ["Mod", "T"] },
  { id: "split-vertical", category: "terminal", labelKey: "settings.keybindings.items.splitVertical", defaultKeys: ["Mod", "\\"] },
  { id: "split-horizontal", category: "terminal", labelKey: "settings.keybindings.items.splitHorizontal", defaultKeys: ["Mod", "Shift", "\\"] },
  { id: "search-terminal", category: "terminal", labelKey: "settings.keybindings.items.searchTerminal", defaultKeys: ["Mod", "F"] },
  { id: "new-ssh", category: "ssh", labelKey: "settings.keybindings.items.newSsh", defaultKeys: ["Mod", "N"] },
  { id: "toggle-ai", category: "ai", labelKey: "settings.keybindings.items.toggleAi", defaultKeys: ["Alt", "`"] },
  { id: "toggle-bottom-workspace", category: "workspace", labelKey: "settings.keybindings.items.toggleBottomWorkspace", defaultKeys: ["Alt", "KeyW"] },
];

const SHORTCUT_DEFS_BY_ID: Record<string, ShortcutDef> = Object.fromEntries(
  SHORTCUT_DEFS.map((d) => [d.id, d])
);

interface ShortcutsState {
  /** 用户自定义覆盖：id → 按键组合 */
  overrides: Record<string, KeyToken[]>;
  setShortcut: (id: string, keys: KeyToken[]) => void;
  resetShortcut: (id: string) => void;
  resetAll: () => void;
}

export const useShortcutsStore = create<ShortcutsState>()(
  persist(
    (set) => ({
      overrides: {},
      setShortcut: (id, keys) =>
        set((s) => {
          if (SHORTCUT_DEFS_BY_ID[id]?.nonRecordable) return s;
          const def = SHORTCUT_DEFS_BY_ID[id];
          const sameAsDefault =
            def &&
            def.defaultKeys.length === keys.length &&
            def.defaultKeys.every((k, i) => k === keys[i]);
          const next = { ...s.overrides };
          if (sameAsDefault) {
            delete next[id];
          } else {
            next[id] = keys;
          }
          return { overrides: next };
        }),
      resetShortcut: (id) =>
        set((s) => {
          if (!(id in s.overrides)) return s;
          const next = { ...s.overrides };
          delete next[id];
          return { overrides: next };
        }),
      resetAll: () => set({ overrides: {} }),
    }),
    {
      name: "omnipanel-shortcuts",
      version: 1,
      partialize: (s) => ({ overrides: s.overrides }),
    }
  )
);

/** 取得某个快捷键当前实际生效的按键组合（覆盖值或默认值） */
export function getShortcutKeys(id: string): KeyToken[] {
  const def = SHORTCUT_DEFS_BY_ID[id];
  if (!def) return [];
  const override = useShortcutsStore.getState().overrides[id];
  return override ?? def.defaultKeys;
}

/** 与默认组合对比，判断是否被用户修改过 */
export function isShortcutCustomized(id: string): boolean {
  return id in useShortcutsStore.getState().overrides;
}

/** 按键码 → 展示文本（主按键） */
export function prettyKey(token: string): string {
  switch (token) {
    case "Mod":
      return modKeyLabel();
    case "Shift":
      return "Shift";
    case "Alt":
      return isMacOS() ? "⌥" : "Alt";
    case "Backquote":
      return "`";
    case "Backslash":
      return "\\";
    case "Slash":
      return "/";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Space":
      return "Space";
    case "Tab":
      return "Tab";
    case "Enter":
      return "Enter";
    case "Escape":
      return "Esc";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    default:
      if (token.length === 1) return token.toUpperCase();
      if (/^Key[A-Z]$/.test(token)) return token.slice(3);
      if (/^Digit\d$/.test(token)) return token.slice(5);
      return token;
  }
}

/** 把 KeyToken[] 渲染为人类可读字符串（macOS 使用符号） */
export function formatShortcut(keys: KeyToken[]): string {
  return keys
    .map((k) => {
      if (k === "Mod") return modKeyLabel();
      if (k === "Alt") return isMacOS() ? "⌥" : "Alt";
      return prettyKey(k);
    })
    .join(isMacOS() ? "" : "+");
}

/** 把 KeyToken[] 拆为修饰键集合 + 主按键字符串 */
export function splitModifiers(keys: KeyToken[]): {
  mods: ("Mod" | "Shift" | "Alt")[];
  main: string | null;
} {
  const mods: ("Mod" | "Shift" | "Alt")[] = [];
  let main: string | null = null;
  for (const k of keys) {
    if (k === "Mod" || k === "Shift" || k === "Alt") {
      if (!mods.includes(k)) mods.push(k);
    } else {
      main = k;
    }
  }
  return { mods, main };
}

/**
 * 判断一个 KeyboardEvent 是否匹配指定的 KeyToken[]。
 * 用于实际的全局快捷键触发（如 AI 抽屉切换、命令面板等）。
 */
export function matchesShortcut(e: KeyboardEvent, keys: KeyToken[]): boolean {
  if (e.type !== "keydown") return false;
  const { mods, main } = splitModifiers(keys);
  if (!main) return false;
  if (mods.includes("Mod") !== isModKeyOn(e)) return false;
  if (mods.includes("Shift") !== e.shiftKey) return false;
  if (mods.includes("Alt") !== e.altKey) return false;
  return mainKeyMatches(e, main);
}

/** 平台相关的 Mod 键（与 lib/platform.isModKeyPressed 一致；不依赖 navigator） */
function isModKeyOn(e: KeyboardEvent): boolean {
  return isMacOS() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** 主按键匹配：支持 e.code 优先（如 Backquote、KeyL、Digit1），回退到 e.key */
function mainKeyMatches(e: KeyboardEvent, main: string): boolean {
  if (e.code === main) return true;
  if (/^Key[A-Z]$/.test(main) && (e.code === main || e.key.toUpperCase() === main.slice(3))) {
    return true;
  }
  if (/^Digit\d$/.test(main) && (e.code === main || e.key === main.slice(5))) {
    return true;
  }
  if (e.key === main || e.key === prettyKey(main)) return true;
  return false;
}

/**
 * 从 KeyboardEvent 反推出规范化 KeyToken[]（仅修饰键 + 单一主键）。
 * 用于 ShortcutRecorder 在用户按键时记录。
 */
export function eventToKeyTokens(e: KeyboardEvent): KeyToken[] | null {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
    // 修饰键被按下时忽略单独的修饰键按下事件
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  }

  const tokens: KeyToken[] = [];
  if (isModKeyOn(e)) tokens.push("Mod");
  if (e.shiftKey) tokens.push("Shift");
  if (e.altKey) tokens.push("Alt");

  const main = codeToKeyToken(e);
  if (!main) return null;
  tokens.push(main);
  return tokens;
}

function codeToKeyToken(e: KeyboardEvent): string | null {
  if (!e.code || e.code === "Unidentified") {
    if (!e.key) return null;
    if (e.key.length === 1) return e.key;
    return null;
  }
  // 兼容默认键：Backquote、Backslash、Comma、Digit1..9、KeyA..KeyZ 等直接保留
  return e.code;
}

/** 已被其它快捷键占用的 KeyToken[] 集合（用于冲突检测） */
export function findShortcutConflict(
  candidate: KeyToken[],
  excludeId?: string
): ShortcutDef | null {
  for (const def of SHORTCUT_DEFS) {
    if (def.nonRecordable) continue;
    if (excludeId && def.id === excludeId) continue;
    if (sameKeys(def.defaultKeys, candidate)) return def;
    const override = useShortcutsStore.getState().overrides[def.id];
    if (override && sameKeys(override, candidate)) return def;
  }
  return null;
}

function sameKeys(a: KeyToken[], b: KeyToken[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((k, i) => k === b[i]);
}
