import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isMacOS, modKeyLabel } from "../lib/platform";

/**
 * 规范化快捷键令牌：
 * - "Mod" / "Shift" / "Alt"  → 修饰键（Mod 在 macOS 上表示 ⌘，其它平台表示 Ctrl）
 * - 其它字符串                → 主按键，使用 KeyboardEvent.code / KeyboardEvent.key 的值
 */
export type KeyToken = "Mod" | "Shift" | "Alt" | string;

/** 一组按键组合（修饰键 + 单一主键） */
export type KeyBinding = KeyToken[];

/** 设置页中的模块分类 */
export type ShortcutCategory =
  | "general"
  | "tabs"
  | "terminal"
  | "ssh"
  | "ai"
  | "workspace"
  | "sqlEditor";

/** 设置页快捷键折叠面板的显示顺序 */
export const SHORTCUT_CATEGORY_ORDER: ShortcutCategory[] = [
  "general",
  "tabs",
  "terminal",
  "ssh",
  "ai",
  "workspace",
  "sqlEditor",
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
  /** 默认主绑定（向后兼容；第一个绑定） */
  defaultKeys: KeyBinding;
  /** 默认备用绑定列表（可多个；满足"一个操作绑定多个快捷键"需求） */
  defaultAltKeys?: KeyBinding[];
  /**
   * 该条目是否支持录制（如 "1-9" 这种占位表达无法用单一组合表示，标记为只读）
   */
  nonRecordable?: boolean;
}

/** 内置的快捷键定义。新增条目时同步加进两端 i18n。 */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  // ─── general ────────────────────────────────────────────────────
  { id: "command-palette", category: "general", labelKey: "settings.keybindings.items.commandPalette", defaultKeys: ["Mod", "K"] },
  { id: "search-everywhere", category: "general", labelKey: "settings.keybindings.items.searchEverywhere", defaultKeys: ["Shift", "Shift"], nonRecordable: true },
  { id: "recent-items", category: "general", labelKey: "settings.keybindings.items.recentItems", defaultKeys: ["Mod", "KeyE"] },
  { id: "open-settings", category: "general", labelKey: "settings.keybindings.items.openSettings", defaultKeys: ["Mod", ","] },

  // ─── tabs ──────────────────────────────────────────────────────
  { id: "close-tab", category: "tabs", labelKey: "settings.keybindings.items.closeTab", defaultKeys: ["Mod", "W"] },
  { id: "switch-tab", category: "tabs", labelKey: "settings.keybindings.items.switchTab", defaultKeys: ["Mod", "Tab"], defaultAltKeys: [["Mod", "PageDown"]] },
  { id: "switch-tab-prev", category: "tabs", labelKey: "settings.keybindings.items.switchTabPrev", defaultKeys: ["Mod", "Shift", "Tab"], defaultAltKeys: [["Mod", "PageUp"]] },
  { id: "switch-nth-tab", category: "tabs", labelKey: "settings.keybindings.items.switchNthTab", defaultKeys: ["Mod", "1-9"], nonRecordable: true },
  { id: "rename-tab", category: "tabs", labelKey: "settings.keybindings.items.renameTab", defaultKeys: ["F2"] },

  // ─── terminal ──────────────────────────────────────────────────
  { id: "new-terminal", category: "terminal", labelKey: "settings.keybindings.items.newTerminal", defaultKeys: ["Mod", "T"] },
  { id: "split-vertical", category: "terminal", labelKey: "settings.keybindings.items.splitVertical", defaultKeys: ["Mod", "Backslash"] },
  { id: "split-horizontal", category: "terminal", labelKey: "settings.keybindings.items.splitHorizontal", defaultKeys: ["Mod", "Shift", "Backslash"] },
  { id: "search-terminal", category: "terminal", labelKey: "settings.keybindings.items.searchTerminal", defaultKeys: ["Mod", "F"] },
  { id: "clear-terminal", category: "terminal", labelKey: "settings.keybindings.items.clearTerminal", defaultKeys: ["Mod", "KeyL"], defaultAltKeys: [["Mod", "Shift", "KeyK"]] },
  { id: "copy-terminal", category: "terminal", labelKey: "settings.keybindings.items.copyTerminal", defaultKeys: ["Mod", "Shift", "KeyC"] },
  { id: "paste-terminal", category: "terminal", labelKey: "settings.keybindings.items.pasteTerminal", defaultKeys: ["Mod", "Shift", "KeyV"] },
  { id: "scroll-terminal-top", category: "terminal", labelKey: "settings.keybindings.items.scrollTerminalTop", defaultKeys: ["Mod", "Home"] },
  { id: "scroll-terminal-bottom", category: "terminal", labelKey: "settings.keybindings.items.scrollTerminalBottom", defaultKeys: ["Mod", "End"] },
  { id: "new-ssh", category: "ssh", labelKey: "settings.keybindings.items.newSsh", defaultKeys: ["Mod", "N"] },

  // ─── ai / workspace ────────────────────────────────────────────
  { id: "toggle-ai", category: "ai", labelKey: "settings.keybindings.items.toggleAi", defaultKeys: ["Alt", "Backquote"] },
  { id: "toggle-bottom-workspace", category: "workspace", labelKey: "settings.keybindings.items.toggleBottomWorkspace", defaultKeys: ["Alt", "KeyW"] },

  // ─── sqlEditor ─────────────────────────────────────────────────
  { id: "run-current-sql", category: "sqlEditor", labelKey: "settings.keybindings.items.runCurrentSql", defaultKeys: ["Mod", "Enter"], defaultAltKeys: [["Mod", "Shift", "KeyR"]] },
  { id: "run-selected-sql", category: "sqlEditor", labelKey: "settings.keybindings.items.runSelectedSql", defaultKeys: ["Mod", "Shift", "Enter"], defaultAltKeys: [["Mod", "Shift", "KeyR"]] },
  { id: "run-all-sql", category: "sqlEditor", labelKey: "settings.keybindings.items.runAllSql", defaultKeys: ["Mod", "Shift", "Alt", "Enter"] },
  { id: "save-sql-file", category: "sqlEditor", labelKey: "settings.keybindings.items.saveSqlFile", defaultKeys: ["Mod", "KeyS"] },
  { id: "new-query", category: "sqlEditor", labelKey: "settings.keybindings.items.newQuery", defaultKeys: ["Mod", "Shift", "KeyN"] },
  { id: "format-sql", category: "sqlEditor", labelKey: "settings.keybindings.items.formatSql", defaultKeys: ["Alt", "KeyF"] },
  { id: "format-sql-statement", category: "sqlEditor", labelKey: "settings.keybindings.items.formatSqlStatement", defaultKeys: ["Alt", "Shift", "KeyF"] },
  { id: "switch-connection", category: "sqlEditor", labelKey: "settings.keybindings.items.switchConnection", defaultKeys: ["Mod", "Shift", "KeyC"] },
  { id: "switch-database", category: "sqlEditor", labelKey: "settings.keybindings.items.switchDatabase", defaultKeys: ["Mod", "Shift", "KeyD"] },
];

const SHORTCUT_DEFS_BY_ID: Record<string, ShortcutDef> = Object.fromEntries(
  SHORTCUT_DEFS.map((d) => [d.id, d])
);

/** 取得某个快捷键定义的所有默认绑定（主 + 备用） */
function getDefaultBindings(def: ShortcutDef): KeyBinding[] {
  const all: KeyBinding[] = [def.defaultKeys];
  if (def.defaultAltKeys) all.push(...def.defaultAltKeys);
  return all;
}

interface ShortcutsState {
  /** 用户自定义覆盖：id → 绑定列表（包含主+备，覆盖默认） */
  overrides: Record<string, KeyBinding[]>;
  /** 设置整个快捷键的绑定列表（替换所有绑定） */
  setShortcut: (id: string, bindings: KeyBinding[]) => void;
  /** 添加一个绑定到现有列表（去重） */
  addBinding: (id: string, keys: KeyBinding) => void;
  /** 移除指定索引的绑定 */
  removeBinding: (id: string, index: number) => void;
  /** 重置为默认 */
  resetShortcut: (id: string) => void;
  /** 重置全部 */
  resetAll: () => void;
}

export const useShortcutsStore = create<ShortcutsState>()(
  persist(
    (set) => ({
      overrides: {},
      setShortcut: (id, bindings) =>
        set((s) => {
          if (SHORTCUT_DEFS_BY_ID[id]?.nonRecordable) return s;
          const def = SHORTCUT_DEFS_BY_ID[id];
          if (!def) return s;
          const defaults = getDefaultBindings(def);
          const sameAsDefault =
            bindings.length === defaults.length &&
            bindings.every((b, i) => sameKeys(b, defaults[i]));
          const next = { ...s.overrides };
          if (sameAsDefault) {
            delete next[id];
          } else {
            next[id] = bindings;
          }
          return { overrides: next };
        }),
      addBinding: (id, keys) =>
        set((s) => {
          if (SHORTCUT_DEFS_BY_ID[id]?.nonRecordable) return s;
          const def = SHORTCUT_DEFS_BY_ID[id];
          if (!def) return s;
          const current = s.overrides[id] ?? getDefaultBindings(def);
          // 去重
          if (current.some((b) => sameKeys(b, keys))) return s;
          const next = { ...s.overrides, [id]: [...current, keys] };
          return { overrides: next };
        }),
      removeBinding: (id, index) =>
        set((s) => {
          const def = SHORTCUT_DEFS_BY_ID[id];
          if (!def) return s;
          const current = s.overrides[id] ?? getDefaultBindings(def);
          if (index < 0 || index >= current.length) return s;
          // 至少保留一个绑定
          if (current.length <= 1) return s;
          const next = current.filter((_, i) => i !== index);
          const defaults = getDefaultBindings(def);
          const sameAsDefault =
            next.length === defaults.length &&
            next.every((b, i) => sameKeys(b, defaults[i]));
          const newOverrides = { ...s.overrides };
          if (sameAsDefault) {
            delete newOverrides[id];
          } else {
            newOverrides[id] = next;
          }
          return { overrides: newOverrides };
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
      version: 2,
      partialize: (s) => ({ overrides: s.overrides }),
      migrate: (persistedState, fromVersion) => {
        const persisted = persistedState as {
          overrides?: Record<string, KeyToken[] | KeyBinding[]>;
        };
        if (!persisted) return persistedState as ShortcutsState;
        // v1 → v2：把每个 override 从 KeyToken[] 升级为 KeyBinding[]（包一层 []）
        if (fromVersion < 2 && persisted.overrides) {
          const migrated: Record<string, KeyBinding[]> = {};
          for (const [id, val] of Object.entries(persisted.overrides)) {
            if (!val) continue;
            if (Array.isArray(val) && val.length > 0 && Array.isArray(val[0])) {
              // 已经是 KeyBinding[] 形态
              migrated[id] = val as KeyBinding[];
            } else {
              // 旧形态 KeyToken[] → 包一层
              migrated[id] = [val as KeyToken[]];
            }
          }
          persisted.overrides = migrated;
        }
        return persisted as ShortcutsState;
      },
    }
  )
);

/** 取得某个快捷键当前实际生效的所有绑定（覆盖值或默认值） */
export function getShortcutKeys(id: string): KeyBinding[] {
  const def = SHORTCUT_DEFS_BY_ID[id];
  if (!def) return [];
  const override = useShortcutsStore.getState().overrides[id];
  return override ?? getDefaultBindings(def);
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
    case "Home":
      return "Home";
    case "End":
      return "End";
    case "PageUp":
      return "PageUp";
    case "PageDown":
      return "PageDown";
    default:
      if (token.length === 1) return token.toUpperCase();
      if (/^Key[A-Z]$/.test(token)) return token.slice(3);
      if (/^Digit\d$/.test(token)) return token.slice(5);
      if (/^F\d{1,2}$/.test(token)) return token;
      return token;
  }
}

/** 把单个 KeyBinding 渲染为人类可读字符串 */
export function formatShortcut(keys: KeyBinding): string {
  return keys
    .map((k) => {
      if (k === "Mod") return modKeyLabel();
      if (k === "Alt") return isMacOS() ? "⌥" : "Alt";
      return prettyKey(k);
    })
    .join(isMacOS() ? "" : "+");
}

/** 把多个绑定渲染为可读字符串（用 " / " 分隔，如 "Ctrl+Enter / Ctrl+Shift+R"） */
export function formatShortcutList(keysList: KeyBinding[]): string {
  return keysList.map(formatShortcut).join(" / ");
}

/** 把 KeyBinding 拆为修饰键集合 + 主按键字符串 */
export function splitModifiers(keys: KeyBinding): {
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
 * 判断一个 KeyboardEvent 是否匹配指定的任意一个绑定。
 * keys 为 KeyBinding[]（多绑定），匹配其中任意一个即返回 true。
 */
export function matchesShortcut(e: KeyboardEvent, keys: KeyBinding[]): boolean {
  if (e.type !== "keydown") return false;
  if (!keys || keys.length === 0) return false;
  return keys.some((binding) => matchesSingleBinding(e, binding));
}

/** 单个绑定匹配 */
function matchesSingleBinding(e: KeyboardEvent, binding: KeyBinding): boolean {
  const { mods, main } = splitModifiers(binding);
  if (!main) return false;
  if (mods.includes("Mod") !== isModKeyOn(e)) return false;
  if (mods.includes("Shift") !== e.shiftKey) return false;
  if (mods.includes("Alt") !== e.altKey) return false;
  return mainKeyMatches(e, main);
}

/** 平台相关的 Mod 键 */
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
 * 从 KeyboardEvent 反推出规范化 KeyBinding（仅修饰键 + 单一主键）。
 * 用于 ShortcutRecorder 在用户按键时记录。
 */
export function eventToKeyTokens(e: KeyboardEvent): KeyBinding | null {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
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
  return e.code;
}

/** 已被其它快捷键占用的 KeyBinding 集合（用于冲突检测） */
export function findShortcutConflict(
  candidate: KeyBinding,
  excludeId?: string
): ShortcutDef | null {
  for (const def of SHORTCUT_DEFS) {
    if (def.nonRecordable) continue;
    if (excludeId && def.id === excludeId) continue;
    const all = getShortcutKeys(def.id);
    if (all.some((b) => sameKeys(b, candidate))) return def;
  }
  return null;
}

function sameKeys(a: KeyBinding, b: KeyBinding): boolean {
  if (a.length !== b.length) return false;
  return a.every((k, i) => k === b[i]);
}
