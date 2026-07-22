import { create } from "zustand";
import { commands, type TagDto } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";

/** 稳定空数组，避免 selector 里 `?? []` 每次新建引用触发无限重渲染 */
export const EMPTY_TAG_IDS: string[] = [];

interface TagStoreState {
  tags: TagDto[];
  loaded: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
}

let refreshInflight: Promise<void> | null = null;

export const useTagStore = create<TagStoreState>((set) => ({
  tags: [],
  loaded: false,
  loading: false,
  refresh: () => {
    if (refreshInflight) return refreshInflight;
    set({ loading: true });
    refreshInflight = (async () => {
      try {
        const tags = await unwrapCommand(commands.tagListTree(true));
        set({ tags, loaded: true, loading: false });
      } catch {
        set({ tags: [], loaded: true, loading: false });
      } finally {
        refreshInflight = null;
      }
    })();
    return refreshInflight;
  },
}));

/** UI：标题栏标签弹窗聚焦、各模块筛选状态 */
interface TagUiState {
  /** 递增以触发对应模块打开标签弹窗 */
  focusNonce: number;
  /** 最近一次 focus 的 moduleKey；null 表示任意模块 */
  focusModuleKey: string | null;
  focusTagPanel: (moduleKey?: string | null) => void;
  /** moduleKey -> AND/OR */
  matchModes: Record<string, "and" | "or">;
  setMatchMode: (moduleKey: string, mode: "and" | "or") => void;
  /** moduleKey -> 选中的 tag ids */
  selectedByModule: Record<string, string[]>;
  setSelected: (moduleKey: string, ids: string[]) => void;
  toggleSelected: (moduleKey: string, id: string) => void;
}

const MODE_KEY = "omnipanel-tag-match-modes";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const useTagUiStore = create<TagUiState>((set, get) => ({
  focusNonce: 0,
  focusModuleKey: null,
  focusTagPanel: (moduleKey = null) => {
    set((s) => ({
      focusNonce: s.focusNonce + 1,
      focusModuleKey: moduleKey ?? null,
    }));
  },
  matchModes: loadJson(MODE_KEY, {}),
  setMatchMode: (moduleKey, mode) => {
    const matchModes = { ...get().matchModes, [moduleKey]: mode };
    localStorage.setItem(MODE_KEY, JSON.stringify(matchModes));
    set({ matchModes });
  },
  selectedByModule: {},
  setSelected: (moduleKey, ids) =>
    set((s) => ({
      selectedByModule: {
        ...s.selectedByModule,
        [moduleKey]: ids.length === 0 ? EMPTY_TAG_IDS : ids,
      },
    })),
  toggleSelected: (moduleKey, id) => {
    const cur = get().selectedByModule[moduleKey] ?? EMPTY_TAG_IDS;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    set((s) => ({
      selectedByModule: {
        ...s.selectedByModule,
        [moduleKey]: next.length === 0 ? EMPTY_TAG_IDS : next,
      },
    }));
  },
}));

export function buildTagTree(tags: TagDto[]): TagTreeNode[] {
  const byParent = new Map<string, TagDto[]>();
  for (const tag of tags) {
    const key = tag.parentId ?? "";
    const list = byParent.get(key) ?? [];
    list.push(tag);
    byParent.set(key, list);
  }
  const walk = (parentId: string): TagTreeNode[] => {
    const children = byParent.get(parentId) ?? [];
    return children
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "zh"))
      .map((tag) => ({
        tag,
        children: walk(tag.id),
      }));
  };
  return walk("");
}

export interface TagTreeNode {
  tag: TagDto;
  children: TagTreeNode[];
}
