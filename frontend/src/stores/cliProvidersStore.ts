import { create } from "zustand";

import { persist, createJSONStorage } from "zustand/middleware";



import { commands, type CliProviderRecord } from "../ipc/bindings";

import { isSupportedAgentKind } from "../lib/agents/types";

import { isTauriRuntime } from "../lib/isTauriRuntime";

import { useAcpServicesStore } from "./acpServicesStore";



interface CliProvidersState {

  providers: CliProviderRecord[];

  modelCache: Record<string, string[]>;

  loading: boolean;

  syncing: boolean;

  error: string | null;

  refreshingModelIds: Record<string, boolean>;

  syncProviders: (options?: { forceModels?: boolean }) => Promise<void>;

  refreshModels: (providerId: string, options?: { silent?: boolean }) => Promise<string[]>;

  setProviderEnabled: (id: string, enabled: boolean) => Promise<boolean>;

  setModelEnabled: (providerId: string, modelName: string, enabled: boolean) => Promise<boolean>;

  addManualModel: (providerId: string, modelName: string) => Promise<{ ok: true } | { ok: false; error: string }>;

  removeModel: (providerId: string, modelName: string) => Promise<void>;

  setAllModelsEnabled: (providerId: string, enabled: boolean) => Promise<boolean>;

  clearError: () => void;

}



function upsertProvider(list: CliProviderRecord[], next: CliProviderRecord): CliProviderRecord[] {

  const idx = list.findIndex((p) => p.id === next.id);

  if (idx < 0) return [...list, next];

  const copy = [...list];

  copy[idx] = next;

  return copy;

}



function mergeProviderLists(

  current: CliProviderRecord[],

  incoming: CliProviderRecord[],

): CliProviderRecord[] {

  if (current.length === 0) return incoming;

  const byId = new Map(current.map((p) => [p.id, p]));

  return incoming.map((next) => {

    const prev = byId.get(next.id);

    if (!prev) return next;

    return {

      ...next,

      // 保留展开 UI 期间已拉取的模型缓存对应字段，避免闪烁

      manualModelNames: next.manualModelNames ?? prev.manualModelNames,

      disabledModelNames: next.disabledModelNames ?? prev.disabledModelNames,

    };

  });

}



function syncAcpEnabled(id: string, enabled: boolean) {

  if (!isSupportedAgentKind(id)) return;

  const services = useAcpServicesStore.getState().services;

  useAcpServicesStore.setState({

    services: services.map((s) => (s.id === id ? { ...s, enabled, isActive: enabled } : s)),

  });

}



export function countEnabledCliModels(provider: CliProviderRecord, models: string[]): number {

  const disabled = new Set(provider.disabledModelNames ?? []);

  return models.filter((name) => !disabled.has(name)).length;

}



export function isCliModelEnabled(provider: CliProviderRecord, modelName: string): boolean {

  return !(provider.disabledModelNames ?? []).includes(modelName);

}



export function isManualCliModel(provider: CliProviderRecord, modelName: string): boolean {

  return (provider.manualModelNames ?? []).includes(modelName);

}



export function getCliProviderModels(

  provider: CliProviderRecord,

  modelCache: Record<string, string[]>,

): string[] {

  const cached = modelCache[provider.id];

  if (cached !== undefined) return cached;

  const fromStatic = provider.staticModels ?? [];

  const manual = provider.manualModelNames ?? [];

  const merged = [...fromStatic];

  for (const name of manual) {

    if (!merged.includes(name)) merged.push(name);

  }

  return merged;

}



export const useCliProvidersStore = create<CliProvidersState>()(

  persist(

    (set, get) => ({

      providers: [],

      modelCache: {},

      loading: false,

      syncing: false,

      error: null,

      refreshingModelIds: {},



      clearError: () => set({ error: null }),



      syncProviders: async (options) => {

        if (!isTauriRuntime()) return;

        const hasSnapshot = get().providers.length > 0;

        set({

          syncing: true,

          loading: !hasSnapshot,

          error: null,

        });

        try {

          const res = await commands.cliProviderListCmd();

          if (res.status === "ok") {

            set({

              providers: mergeProviderLists(get().providers, res.data),

            });

            const toRefresh = res.data.filter(

              (p) => p.enabled && Boolean(p.binary?.trim()) && (options?.forceModels || !get().modelCache[p.id]?.length),

            );

            await Promise.all(

              toRefresh.map((p) =>

                get()

                  .refreshModels(p.id, { silent: true })

                  .catch(() => undefined),

              ),

            );

          } else {

            set({ error: res.error });

          }

        } catch (e) {

          set({ error: e instanceof Error ? e.message : String(e) });

        } finally {

          set({ loading: false, syncing: false });

        }

      },



      refreshModels: async (providerId, options) => {

        if (!isTauriRuntime()) return get().modelCache[providerId] ?? [];

        if (!options?.silent) {

          set({

            refreshingModelIds: { ...get().refreshingModelIds, [providerId]: true },

            error: null,

          });

        }

        try {

          const res = await commands.providerListModelsCmd(providerId);

          if (res.status === "ok") {

            set({

              modelCache: { ...get().modelCache, [providerId]: res.data },

            });

            return res.data;

          }

          const err = (res as { error: string | { message?: string } }).error;
          const message = typeof err === "string" ? err : err?.message ?? "刷新模型列表失败";

          throw new Error(message);

        } catch (e) {

          const message = e instanceof Error ? e.message : String(e);

          if (!options?.silent) {

            set({ error: message });

          }

          throw e;

        } finally {

          if (!options?.silent) {

            const next = { ...get().refreshingModelIds };

            delete next[providerId];

            set({ refreshingModelIds: next });

          }

        }

      },



      setProviderEnabled: async (id, enabled) => {

        if (!isTauriRuntime()) return false;

        const prev = get().providers.find((p) => p.id === id);

        if (!prev) return false;



        set({

          error: null,

          providers: upsertProvider(get().providers, { ...prev, enabled }),

        });

        syncAcpEnabled(id, enabled);



        try {

          const res = await commands.cliProviderPatchCmd({ id, enabled });

          if (res.status === "ok") {

            set({ providers: upsertProvider(get().providers, res.data) });

            syncAcpEnabled(id, res.data.enabled ?? enabled);

            if (enabled && res.data.binary) {

              void get().refreshModels(id, { silent: true }).catch(() => undefined);

            }

            return true;

          }

          set({

            providers: upsertProvider(get().providers, prev),

            error: res.error,

          });

          syncAcpEnabled(id, prev.enabled ?? false);

          return false;

        } catch (e) {

          set({

            providers: upsertProvider(get().providers, prev),

            error: e instanceof Error ? e.message : String(e),

          });

          syncAcpEnabled(id, prev.enabled ?? false);

          return false;

        }

      },



      setModelEnabled: async (providerId, modelName, enabled) => {

        if (!isTauriRuntime()) return false;

        const provider = get().providers.find((p) => p.id === providerId);

        if (!provider) return false;



        const prevDisabled = [...(provider.disabledModelNames ?? [])];

        const disabled = new Set(prevDisabled);

        if (enabled) disabled.delete(modelName);

        else disabled.add(modelName);

        const nextDisabled = [...disabled];



        set({

          error: null,

          providers: upsertProvider(get().providers, {

            ...provider,

            disabledModelNames: nextDisabled,

          }),

        });



        try {

          const res = await commands.cliProviderPatchCmd({

            id: providerId,

            disabledModelNames: nextDisabled,

          });

          if (res.status === "ok") {

            set({ providers: upsertProvider(get().providers, res.data) });

            return true;

          }

          set({

            providers: upsertProvider(get().providers, {

              ...provider,

              disabledModelNames: prevDisabled,

            }),

            error: res.error,

          });

          return false;

        } catch (e) {

          set({

            providers: upsertProvider(get().providers, {

              ...provider,

              disabledModelNames: prevDisabled,

            }),

            error: e instanceof Error ? e.message : String(e),

          });

          return false;

        }

      },



      addManualModel: async (providerId, modelName) => {

        const trimmed = modelName.trim();

        if (!trimmed) return { ok: false as const, error: "empty" };

        const provider = get().providers.find((p) => p.id === providerId);

        if (!provider) return { ok: false as const, error: "not_found" };

        const models = getCliProviderModels(provider, get().modelCache);

        if (models.includes(trimmed)) return { ok: false as const, error: "duplicate" };

        const manual = [...(provider.manualModelNames ?? []), trimmed];

        const res = await commands.cliProviderPatchCmd({

          id: providerId,

          manualModelNames: manual,

        });

        if (res.status !== "ok") {

          set({ error: res.error });

          return { ok: false as const, error: res.error };

        }

        set({ providers: upsertProvider(get().providers, res.data), error: null });

        await get().refreshModels(providerId);

        return { ok: true as const };

      },



      removeModel: async (providerId, modelName) => {

        const provider = get().providers.find((p) => p.id === providerId);

        if (!provider) return;

        const manual = (provider.manualModelNames ?? []).filter((n) => n !== modelName);

        const disabled = (provider.disabledModelNames ?? []).filter((n) => n !== modelName);

        const res = await commands.cliProviderPatchCmd({

          id: providerId,

          manualModelNames: manual,

          disabledModelNames: disabled,

        });

        if (res.status === "ok") {

          set({

            providers: upsertProvider(get().providers, res.data),

            modelCache: {

              ...get().modelCache,

              [providerId]: (get().modelCache[providerId] ?? []).filter((n) => n !== modelName),

            },

            error: null,

          });

        } else {

          set({ error: res.error });

        }

      },



      setAllModelsEnabled: async (providerId, enabled) => {

        const provider = get().providers.find((p) => p.id === providerId);

        if (!provider) return false;

        const models = getCliProviderModels(provider, get().modelCache);

        const prevDisabled = [...(provider.disabledModelNames ?? [])];

        const nextDisabled = enabled ? [] : [...models];



        set({

          providers: upsertProvider(get().providers, {

            ...provider,

            disabledModelNames: nextDisabled,

          }),

        });



        const res = await commands.cliProviderPatchCmd({

          id: providerId,

          disabledModelNames: nextDisabled,

        });

        if (res.status === "ok") {

          set({ providers: upsertProvider(get().providers, res.data), error: null });

          return true;

        }

        set({

          providers: upsertProvider(get().providers, {

            ...provider,

            disabledModelNames: prevDisabled,

          }),

          error: res.error,

        });

        return false;

      },

    }),

    {

      name: "omnipanel-cli-providers",

      storage: createJSONStorage(() => localStorage),

      partialize: (state) => ({

        providers: state.providers,

        modelCache: state.modelCache,

      }),

    },

  ),

);

export async function initCliProvidersStore(): Promise<void> {
  // 启动时不拉取 CLI 提供者，使用 localStorage 缓存；进入设置页时再 sync
}


