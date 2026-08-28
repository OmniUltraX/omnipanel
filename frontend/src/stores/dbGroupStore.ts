import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface DbConnectionGroup {
  id: string;
  name: string;
  builtin?: boolean;
}

export const BUILTIN_DB_GROUPS: DbConnectionGroup[] = [
  { id: "default", name: "默认", builtin: true },
  { id: "test", name: "测试", builtin: true },
  { id: "production", name: "生产", builtin: true },
];

/** persist 覆盖 groups 时补上新增内置组，避免老用户看不到新分组。 */
export function mergeBuiltinDbGroups(persisted: DbConnectionGroup[] | undefined): DbConnectionGroup[] {
  const extras = (persisted ?? []).filter(
    (group) => !BUILTIN_DB_GROUPS.some((builtin) => builtin.id === group.id || builtin.name === group.name),
  );
  return [...BUILTIN_DB_GROUPS, ...extras];
}

interface DbGroupState {
  groups: DbConnectionGroup[];
  activeGroupId: string;
  addGroup: (name: string) => { ok: true; group: DbConnectionGroup } | { ok: false; reason: "empty" | "duplicate" };
  setActiveGroupId: (id: string) => void;
  getGroupById: (id: string) => DbConnectionGroup | undefined;
  getGroupName: (id: string) => string;
}

export const useDbGroupStore = create<DbGroupState>()(
  persist(
    (set, get) => ({
      groups: BUILTIN_DB_GROUPS,
      activeGroupId: "default",
      addGroup: (name) => {
        const trimmed = name.trim();
        if (!trimmed) {
          return { ok: false, reason: "empty" };
        }
        if (get().groups.some((group) => group.name === trimmed)) {
          return { ok: false, reason: "duplicate" };
        }
        const group: DbConnectionGroup = {
          id: `db-group-${Date.now()}`,
          name: trimmed,
        };
        set((state) => ({
          groups: [...state.groups, group],
          activeGroupId: group.id,
        }));
        return { ok: true, group };
      },
      setActiveGroupId: (id) => {
        if (get().groups.some((group) => group.id === id)) {
          set({ activeGroupId: id });
        }
      },
      getGroupById: (id) => get().groups.find((group) => group.id === id),
      getGroupName: (id) => get().getGroupById(id)?.name ?? BUILTIN_DB_GROUPS[0].name,
    }),
    {
      name: "omnipanel-db-groups",
      partialize: (state) => ({
        groups: state.groups,
        activeGroupId: state.activeGroupId,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<DbGroupState>;
        const groups = mergeBuiltinDbGroups(saved.groups);
        const activeGroupId =
          saved.activeGroupId && groups.some((group) => group.id === saved.activeGroupId)
            ? saved.activeGroupId
            : current.activeGroupId;
        return {
          ...current,
          ...saved,
          groups,
          activeGroupId,
        };
      },
    },
  ),
);
