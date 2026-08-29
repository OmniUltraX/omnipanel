import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createIndexedDBStorage } from "../lib/indexedDbStorage";
import { commands, type CloudAccountSnapshot, type CloudRegion, type CloudResourceDetail, type CloudResourceRow } from "../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../ipc/result";
import {
  loadCloudAccount,
  loadCloudResources,
} from "../modules/cloud/cloudResourceApi";
import {
  cloudDetailSlotKey,
  cloudListSlotKey,
  EMPTY_CLOUD_ACCOUNT_INVENTORY,
  isCloudInventoryFresh,
  type CloudAccountInventory,
  type CloudDetailCacheEntry,
  type CloudListCacheEntry,
} from "../modules/cloud/cloudInventory";

type RefreshOpts = { force?: boolean; quiet?: boolean };

type CloudInventoryState = {
  byAccount: Record<string, CloudAccountInventory>;
  refreshingKeys: Record<string, true>;
  getAccountInventory: (accountId: string) => CloudAccountInventory;
  isRefreshing: (key: string) => boolean;
  ensureList: (
    accountId: string,
    capability: string,
    regions: string[] | undefined,
    opts?: RefreshOpts,
  ) => Promise<CloudResourceRow[]>;
  ensureDetail: (
    accountId: string,
    capability: string,
    resourceId: string,
    regionId: string | undefined,
    opts?: RefreshOpts,
  ) => Promise<CloudResourceDetail | null>;
  ensureAccount: (accountId: string, opts?: RefreshOpts) => Promise<CloudAccountSnapshot | null>;
  ensureRegions: (accountId: string, opts?: RefreshOpts) => Promise<CloudRegion[]>;
  removeAccount: (accountId: string) => void;
  clearRegions: (accountId?: string) => void;
  clearAll: () => void;
};

const inflight = new Map<string, Promise<unknown>>();

function refreshKey(kind: string, accountId: string, slot: string): string {
  return `${kind}:${accountId}:${slot}`;
}

function asInventory(value: unknown): CloudAccountInventory {
  if (!value || typeof value !== "object") return { ...EMPTY_CLOUD_ACCOUNT_INVENTORY };
  const raw = value as Partial<CloudAccountInventory>;
  return {
    lists: raw.lists && typeof raw.lists === "object" ? raw.lists : {},
    details: raw.details && typeof raw.details === "object" ? raw.details : {},
    snapshot: raw.snapshot,
    regions: raw.regions,
  };
}

function mergeFetchedAt<T extends { fetchedAt?: number }>(
  persisted: Record<string, T> | undefined,
  current: Record<string, T> | undefined,
): Record<string, T> {
  const out: Record<string, T> = { ...(persisted ?? {}) };
  for (const [key, entry] of Object.entries(current ?? {})) {
    const prev = out[key];
    if (!prev || (entry.fetchedAt ?? 0) >= (prev.fetchedAt ?? 0)) {
      out[key] = entry;
    }
  }
  return out;
}

export const useCloudInventoryStore = create<CloudInventoryState>()(
  persist(
    (set, get) => {
      const patchAccount = (
        accountId: string,
        patch: (current: CloudAccountInventory) => CloudAccountInventory,
      ) => {
        set((state) => {
          const current = asInventory(state.byAccount[accountId]);
          return {
            byAccount: {
              ...state.byAccount,
              [accountId]: patch(current),
            },
          };
        });
      };

      const setRefreshing = (key: string, refreshing: boolean) => {
        set((state) => {
          const next = { ...state.refreshingKeys };
          if (refreshing) next[key] = true;
          else delete next[key];
          return { refreshingKeys: next };
        });
      };

      const runExclusive = async <T,>(key: string, task: () => Promise<T>): Promise<T> => {
        const existing = inflight.get(key) as Promise<T> | undefined;
        if (existing) return existing;
        const run = (async () => {
          setRefreshing(key, true);
          try {
            return await task();
          } finally {
            setRefreshing(key, false);
            inflight.delete(key);
          }
        })();
        inflight.set(key, run);
        return run;
      };

      const refreshList = async (
        accountId: string,
        capability: string,
        regions: string[] | undefined,
        opts?: RefreshOpts,
      ): Promise<CloudResourceRow[]> => {
        const slot = cloudListSlotKey(capability, regions);
        const key = refreshKey("list", accountId, slot);
        return runExclusive(key, async () => {
          const prev = get().getAccountInventory(accountId).lists[slot];
          try {
            const rows = await loadCloudResources(
              accountId,
              capability,
              { regions: regions ?? [] },
              { quiet: opts?.quiet ?? Boolean(prev) },
            );
            const entry: CloudListCacheEntry = { rows, fetchedAt: Date.now(), error: null };
            patchAccount(accountId, (current) => ({
              ...current,
              lists: { ...current.lists, [slot]: entry },
            }));
            return rows;
          } catch (err) {
            if (prev) {
              patchAccount(accountId, (current) => ({
                ...current,
                lists: {
                  ...current.lists,
                  [slot]: { ...prev, error: formatIpcError(err) },
                },
              }));
              if (opts?.force) throw err;
              return prev.rows;
            }
            throw err;
          }
        });
      };

      const refreshDetail = async (
        accountId: string,
        capability: string,
        resourceId: string,
        regionId: string | undefined,
        opts?: RefreshOpts,
      ): Promise<CloudResourceDetail | null> => {
        const slot = cloudDetailSlotKey(capability, resourceId, regionId);
        const key = refreshKey("detail", accountId, slot);
        return runExclusive(key, async () => {
          const prev = get().getAccountInventory(accountId).details[slot];
          try {
            const detail = await unwrapCommand(
              commands.cloudGetResource(accountId, capability, resourceId, regionId || null),
              { quiet: opts?.quiet ?? Boolean(prev) },
            );
            const entry: CloudDetailCacheEntry = { detail, fetchedAt: Date.now(), error: null };
            patchAccount(accountId, (current) => ({
              ...current,
              details: { ...current.details, [slot]: entry },
            }));
            return detail;
          } catch (err) {
            if (prev) {
              patchAccount(accountId, (current) => ({
                ...current,
                details: {
                  ...current.details,
                  [slot]: { ...prev, error: formatIpcError(err) },
                },
              }));
              if (opts?.force) throw err;
              return prev.detail;
            }
            throw err;
          }
        });
      };

      return {
        byAccount: {},
        refreshingKeys: {},

        getAccountInventory: (accountId) => asInventory(get().byAccount[accountId]),

        isRefreshing: (key) => Boolean(get().refreshingKeys[key]),

        ensureList: async (accountId, capability, regions, opts) => {
          const slot = cloudListSlotKey(capability, regions);
          const cached = get().getAccountInventory(accountId).lists[slot];
          if (opts?.force) {
            return refreshList(accountId, capability, regions, { ...opts, force: true });
          }
          if (cached && isCloudInventoryFresh(cached.fetchedAt)) {
            return cached.rows;
          }
          if (cached) {
            void refreshList(accountId, capability, regions, { quiet: true });
            return cached.rows;
          }
          return refreshList(accountId, capability, regions, { quiet: opts?.quiet ?? false });
        },

        ensureDetail: async (accountId, capability, resourceId, regionId, opts) => {
          const slot = cloudDetailSlotKey(capability, resourceId, regionId);
          const cached = get().getAccountInventory(accountId).details[slot];
          if (opts?.force) {
            return refreshDetail(accountId, capability, resourceId, regionId, { ...opts, force: true });
          }
          if (cached && isCloudInventoryFresh(cached.fetchedAt)) {
            return cached.detail;
          }
          if (cached) {
            void refreshDetail(accountId, capability, resourceId, regionId, { quiet: true });
            return cached.detail;
          }
          return refreshDetail(accountId, capability, resourceId, regionId, { quiet: opts?.quiet ?? false });
        },

        ensureAccount: async (accountId, opts) => {
          const key = refreshKey("account", accountId, "");
          const cached = get().getAccountInventory(accountId).snapshot;
          const refresh = () =>
            runExclusive(key, async () => {
              const prev = get().getAccountInventory(accountId).snapshot;
              try {
                const snapshot = await loadCloudAccount(accountId, {
                  quiet: opts?.quiet ?? Boolean(prev),
                });
                patchAccount(accountId, (current) => ({
                  ...current,
                  snapshot: { snapshot, fetchedAt: Date.now(), error: null },
                }));
                return snapshot;
              } catch (err) {
                const message = formatIpcError(err);
                patchAccount(accountId, (current) => ({
                  ...current,
                  snapshot: {
                    snapshot: prev?.snapshot ?? {},
                    fetchedAt: prev?.fetchedAt ?? Date.now(),
                    error: message,
                  },
                }));
                if (prev && !opts?.force) return prev.snapshot;
                throw err;
              }
            });
          if (opts?.force) return refresh();
          if (cached && isCloudInventoryFresh(cached.fetchedAt)) return cached.snapshot;
          if (cached) {
            void refresh();
            return cached.snapshot;
          }
          return refresh();
        },

        ensureRegions: async (accountId, opts) => {
          const key = refreshKey("regions", accountId, "");
          const cached = get().getAccountInventory(accountId).regions;
          const refresh = () =>
            runExclusive(key, async () => {
              const prev = get().getAccountInventory(accountId).regions;
              try {
                const raw = await unwrapCommand(commands.cloudListRegions(accountId), {
                  quiet: opts?.quiet ?? Boolean(prev),
                });
                const regions = Array.isArray(raw) ? raw.filter((item) => item.regionId?.trim()) : [];
                patchAccount(accountId, (current) => ({
                  ...current,
                  regions: { regions, fetchedAt: Date.now(), error: null },
                }));
                return regions;
              } catch (err) {
                if (prev) {
                  patchAccount(accountId, (current) => ({
                    ...current,
                    regions: { ...prev, error: formatIpcError(err) },
                  }));
                  if (opts?.force) throw err;
                  return prev.regions;
                }
                throw err;
              }
            });
          if (opts?.force) return refresh();
          if (cached && isCloudInventoryFresh(cached.fetchedAt)) return cached.regions;
          if (cached) {
            void refresh();
            return cached.regions;
          }
          return refresh();
        },

        removeAccount: (accountId) => {
          set((state) => {
            if (!(accountId in state.byAccount)) return state;
            const byAccount = { ...state.byAccount };
            delete byAccount[accountId];
            return { byAccount };
          });
        },

        clearRegions: (accountId) => {
          if (accountId) {
            const current = get().byAccount[accountId];
            if (!current?.regions) return;
            set((state) => ({
              byAccount: {
                ...state.byAccount,
                [accountId]: { ...asInventory(current), regions: undefined },
              },
            }));
            return;
          }
          set((state) => {
            const byAccount = { ...state.byAccount };
            for (const [id, inv] of Object.entries(byAccount)) {
              if (!inv.regions) continue;
              byAccount[id] = { ...inv, regions: undefined };
            }
            return { byAccount };
          });
        },

        clearAll: () => set({ byAccount: {}, refreshingKeys: {} }),
      };
    },
    {
      name: "omnipanel.cloud.inventory",
      version: 1,
      storage: createJSONStorage(createIndexedDBStorage),
      partialize: (state) => ({ byAccount: state.byAccount }),
      merge: (persisted, current) => {
        const p = persisted as Partial<CloudInventoryState> | undefined;
        const byAccount: Record<string, CloudAccountInventory> = {};
        const persistedAccounts = p?.byAccount ?? {};
        const ids = new Set([...Object.keys(persistedAccounts), ...Object.keys(current.byAccount)]);
        for (const id of ids) {
          const persistedInv = asInventory(persistedAccounts[id]);
          const currentInv = asInventory(current.byAccount[id]);
          const snapshot =
            (currentInv.snapshot?.fetchedAt ?? 0) >= (persistedInv.snapshot?.fetchedAt ?? 0)
              ? currentInv.snapshot ?? persistedInv.snapshot
              : persistedInv.snapshot ?? currentInv.snapshot;
          const regions =
            (currentInv.regions?.fetchedAt ?? 0) >= (persistedInv.regions?.fetchedAt ?? 0)
              ? currentInv.regions ?? persistedInv.regions
              : persistedInv.regions ?? currentInv.regions;
          byAccount[id] = {
            lists: mergeFetchedAt(persistedInv.lists, currentInv.lists),
            details: mergeFetchedAt(persistedInv.details, currentInv.details),
            snapshot,
            regions,
          };
        }
        return {
          ...current,
          ...p,
          byAccount,
          refreshingKeys: {},
        };
      },
    },
  ),
);

export function cloudListRefreshKey(
  accountId: string,
  capability: string,
  regions: string[] | undefined,
): string {
  return refreshKey("list", accountId, cloudListSlotKey(capability, regions));
}

export function cloudDetailRefreshKey(
  accountId: string,
  capability: string,
  resourceId: string,
  regionId: string | undefined,
): string {
  return refreshKey("detail", accountId, cloudDetailSlotKey(capability, resourceId, regionId));
}

export function cloudAccountRefreshKey(accountId: string): string {
  return refreshKey("account", accountId, "");
}
