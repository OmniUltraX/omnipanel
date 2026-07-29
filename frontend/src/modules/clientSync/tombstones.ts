import { create } from "zustand";
import { persist } from "zustand/middleware";

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type ClientSyncTombstoneKind =
  | "conversation"
  | "connection"
  | "database"
  | "knowledge"
  | "httpRequest"
  | "httpCollection"
  | "httpEnvironment"
  | "workspace";

export interface ClientSyncTombstone {
  id: string;
  deletedAt: number;
}

function keyOf(kind: ClientSyncTombstoneKind, id: string): string {
  return `${kind}:${id}`;
}

function parseKey(key: string): { kind: string; id: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  return { kind: key.slice(0, i), id: key.slice(i + 1) };
}

interface ClientSyncTombstoneState {
  /** kind:id → deletedAt */
  deleted: Record<string, number>;
  markDeleted: (kind: ClientSyncTombstoneKind, ids: string[], deletedAt?: number) => void;
  pruneExpired: (now?: number) => void;
  listByKind: (kind: ClientSyncTombstoneKind) => ClientSyncTombstone[];
  /** 会话兼容：等同 markDeleted('conversation', …) */
  markConversationDeleted: (ids: string[], deletedAt?: number) => void;
  listConversationTombstones: () => ClientSyncTombstone[];
  mergeRemote: (kind: ClientSyncTombstoneKind, remote: ClientSyncTombstone[]) => void;
  clearIfResurrected: (
    kind: ClientSyncTombstoneKind,
    id: string,
    updatedAt: number,
  ) => void;
  clearAll: () => void;
}

export const useClientSyncTombstoneStore = create<ClientSyncTombstoneState>()(
  persist(
    (set, get) => ({
      deleted: {},
      markDeleted: (kind, ids, deletedAt = Date.now()) => {
        if (ids.length === 0) return;
        set((state) => {
          const next = { ...state.deleted };
          for (const id of ids) {
            const trimmed = id.trim();
            if (!trimmed) continue;
            const k = keyOf(kind, trimmed);
            const prev = next[k] ?? 0;
            if (deletedAt >= prev) next[k] = deletedAt;
          }
          return { deleted: next };
        });
      },
      pruneExpired: (now = Date.now()) => {
        set((state) => {
          const next: Record<string, number> = {};
          for (const [id, at] of Object.entries(state.deleted)) {
            if (now - at <= TOMBSTONE_TTL_MS) next[id] = at;
          }
          return { deleted: next };
        });
      },
      listByKind: (kind) => {
        get().pruneExpired();
        const out: ClientSyncTombstone[] = [];
        for (const [key, deletedAt] of Object.entries(get().deleted)) {
          const parsed = parseKey(key);
          if (!parsed || parsed.kind !== kind) continue;
          out.push({ id: parsed.id, deletedAt });
        }
        return out;
      },
      markConversationDeleted: (ids, deletedAt) => {
        get().markDeleted("conversation", ids, deletedAt);
      },
      listConversationTombstones: () => get().listByKind("conversation"),
      mergeRemote: (kind, remote) => {
        if (!remote.length) return;
        set((state) => {
          const next = { ...state.deleted };
          for (const t of remote) {
            const id = t.id?.trim();
            if (!id) continue;
            const at = Number(t.deletedAt) || 0;
            if (at <= 0) continue;
            const k = keyOf(kind, id);
            const prev = next[k] ?? 0;
            if (at >= prev) next[k] = at;
          }
          return { deleted: next };
        });
      },
      clearIfResurrected: (kind, conversationId, updatedAt) => {
        const id = conversationId.trim();
        if (!id) return;
        const k = keyOf(kind, id);
        set((state) => {
          const deletedAt = state.deleted[k];
          if (deletedAt === undefined || updatedAt <= deletedAt) return state;
          const next = { ...state.deleted };
          delete next[k];
          return { deleted: next };
        });
      },
      clearAll: () => set({ deleted: {} }),
    }),
    {
      name: "omnipanel-client-sync-tombstones.v1",
      version: 2,
      migrate: (persisted, fromVersion) => {
        const raw = (persisted ?? {}) as { deleted?: Record<string, number> };
        const deleted = { ...(raw.deleted ?? {}) };
        if (fromVersion < 2) {
          // v1 仅会话：裸 id → conversation:id
          const next: Record<string, number> = {};
          for (const [k, at] of Object.entries(deleted)) {
            if (k.includes(":")) next[k] = at;
            else next[`conversation:${k}`] = at;
          }
          return { deleted: next };
        }
        return { deleted };
      },
      partialize: (state) => ({ deleted: state.deleted }),
    },
  ),
);

/** 删除会话时记录 tombstone。 */
export function recordConversationTombstones(ids: string[]): void {
  useClientSyncTombstoneStore.getState().markConversationDeleted(ids);
}

export function recordModuleTombstones(
  kind: Exclude<ClientSyncTombstoneKind, "conversation">,
  ids: string[],
): void {
  useClientSyncTombstoneStore.getState().markDeleted(kind, ids);
}

/** IPC 用：`deletedAt` → `deleted_at` 由 serde 处理；前端传 camelCase。 */
export function toIpcTombstones(
  list: ClientSyncTombstone[],
): { id: string; deletedAt: number }[] {
  return list.map((t) => ({ id: t.id, deletedAt: t.deletedAt }));
}
