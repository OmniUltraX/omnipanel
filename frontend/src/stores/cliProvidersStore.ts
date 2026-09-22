import { create } from "zustand";

import { persist, createJSONStorage } from "zustand/middleware";
import { createSafeLocalStorage } from "../lib/zustandPersistStorage";



import { commands, type CliProviderRecord } from "../ipc/bindings";

import { isSupportedAgentKind } from "../lib/agents/types";

import { canUseAiBackend } from "../lib/isTauriRuntime";

import { useAcpServicesStore } from "./acpServicesStore";

/** 智能体左侧在线状态：OpenCode 指 HTTP serve；其它 ACP 指已启用且已安装。 */
export type CliProviderOnlineStatus = "online" | "connecting" | "offline" | "idle";



interface CliProvidersState {

  providers: CliProviderRecord[];

  modelCache: Record<string, string[]>;

  loading: boolean;

  syncing: boolean;

  error: string | null;

  refreshingModelIds: Record<string, boolean>;

  /** 运行时探活结果，不持久化 */
  onlineStatusById: Record<string, CliProviderOnlineStatus>;

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



function syncAcpEnabled(id: string, enabled: boolean) {

  if (!isSupportedAgentKind(id)) return;

  const services = useAcpServicesStore.getState().services;

  useAcpServicesStore.setState({

    services: services.map((s) => (s.id === id ? { ...s, enabled, isActive: enabled } : s)),

  });

}

/** 非 OpenCode：启用且已安装即视为在线；OpenCode 需等模型发现/探活结果。 */
function deriveBaselineOnline(
  provider: CliProviderRecord,
  installed: boolean,
): CliProviderOnlineStatus {
  if (!installed) return "offline";
  if (!provider.enabled) return "idle";
  if (provider.id === "opencode") return "connecting";
  return "online";
}

/**
 * 与设置页 Agents 列表同一套在线态推导。
 * 优先级：未安装 → 刷新中 → store 探活 → 未启用 → OpenCode 有模型缓存视为在线。
 */
export function resolveAgentOnlineStatus(
  providerId: string,
  installed: boolean,
  enabled: boolean,
  stored: CliProviderOnlineStatus | undefined,
  refreshing: boolean,
  modelCount: number,
): CliProviderOnlineStatus {
  if (!installed) return "offline";
  if (refreshing) return "connecting";
  if (stored) return stored;
  if (!enabled) return "idle";
  // 已有模型缓存视为在线，避免 stored 未写入时 OpenCode 永久「连接中」
  if (providerId === "opencode" && modelCount > 0) return "online";
  return providerId === "opencode" ? "connecting" : "online";
}

export function cliProviderOnlineStatusLabelKey(status: CliProviderOnlineStatus): string {
  switch (status) {
    case "online":
      return "settings.cliProviders.online";
    case "connecting":
      return "settings.cliProviders.connecting";
    case "offline":
      return "settings.cliProviders.offline";
    default:
      return "settings.cliProviders.idle";
  }
}

function opencodeDbg(...args: unknown[]) {
  // 调试「连接中」卡住：DevTools Console 过滤 `[opencode-online]`
  console.info("[opencode-online]", new Date().toISOString(), ...args);
}

const OPENCODE_IPC_TIMEOUT_MS = 45_000;

/** 同一 provider 的 refreshModels 去重，避免设置页/选择器/启用 连环打 ensure+/model */
const refreshModelsInflight = new Map<string, Promise<string[]>>();

function withIpcTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `${label} 超时（${ms / 1000}s）；请查看 %TEMP%\\omnipanel-opencode-debug.log 与终端 [opencode] 日志`,
            ),
          ),
        ms,
      );
    }),
  ]);
}



export function countEnabledCliModels(provider: CliProviderRecord, models: string[]): number {
  return models.filter((name) => isCliModelEnabled(provider, name)).length;
}

export function isCliModelEnabled(provider: CliProviderRecord, modelName: string): boolean {
  const disabled = provider.disabledModelNames ?? [];
  if (disabled.length === 0) return true;
  const id = modelIdentityKey(modelName);
  return !disabled.some((d) => d === modelName || modelIdentityKey(d) === id);
}

export function isManualCliModel(provider: CliProviderRecord, modelName: string): boolean {
  const id = modelIdentityKey(modelName);
  return (provider.manualModelNames ?? []).some(
    (m) => m === modelName || modelIdentityKey(m) === id,
  );
}

/** OpenCode 缓存可能带 `\u001f` 显示名；启用/禁用以稳定 id 为准。 */
function modelIdentityKey(raw: string): string {
  const sep = raw.indexOf("\u001f");
  return sep < 0 ? raw : raw.slice(0, sep);
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

      onlineStatusById: {},



      clearError: () => set({ error: null }),



      syncProviders: async (options) => {

        if (!canUseAiBackend()) return;

        const hasSnapshot = get().providers.length > 0;

        set({

          syncing: true,

          loading: !hasSnapshot,

          error: null,

        });

        try {

          const res = await commands.cliProviderListCmd();

          if (res.status === "ok") {
            // 以后端列表为准（含互斥收敛），避免 localStorage 快照盖住 enabled
            const baseline: Record<string, CliProviderOnlineStatus> = {};
            for (const p of res.data) {
              const installed = Boolean(p.binary?.trim());
              baseline[p.id] = deriveBaselineOnline(p, installed);
            }
            set({ providers: res.data, onlineStatusById: { ...get().onlineStatusById, ...baseline } });
            opencodeDbg("syncProviders:baseline", baseline);

            const toRefresh = res.data.filter(

              (p) => p.enabled && Boolean(p.binary?.trim()) && (options?.forceModels || !get().modelCache[p.id]?.length),

            );
            opencodeDbg(
              "syncProviders:toRefresh",
              toRefresh.map((p) => p.id),
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

        if (!canUseAiBackend()) return get().modelCache[providerId] ?? [];

        const existing = refreshModelsInflight.get(providerId);
        if (existing) {
          opencodeDbg("refreshModels:reuse-inflight", { providerId });
          return existing;
        }

        const silent = Boolean(options?.silent);
        const t0 = performance.now();
        opencodeDbg("refreshModels:begin", { providerId, silent, prevOnline: get().onlineStatusById[providerId] });

        const run = (async (): Promise<string[]> => {
        set({
          onlineStatusById: { ...get().onlineStatusById, [providerId]: "connecting" },
          ...(silent
            ? {}
            : {
                refreshingModelIds: { ...get().refreshingModelIds, [providerId]: true },
                error: null,
              }),
        });

        try {

          const ipcPromise = commands.providerListModelsCmd(providerId);
          const res = await (providerId === "opencode"
            ? withIpcTimeout(ipcPromise, OPENCODE_IPC_TIMEOUT_MS, "OpenCode 模型发现")
            : ipcPromise);
          opencodeDbg("refreshModels:ipc", {
            providerId,
            status: res.status,
            elapsedMs: Math.round(performance.now() - t0),
            count: res.status === "ok" ? res.data.length : undefined,
            error: res.status === "ok" ? undefined : (res as { error?: unknown }).error,
          });

          if (res.status === "ok") {

            set({

              modelCache: { ...get().modelCache, [providerId]: res.data },
              onlineStatusById: { ...get().onlineStatusById, [providerId]: "online" },

            });
            opencodeDbg("refreshModels:online", { providerId, count: res.data.length });

            return res.data;

          }

          const err = (res as { error: string | { message?: string } }).error;
          const message = typeof err === "string" ? err : err?.message ?? "刷新模型列表失败";

          throw new Error(message);

        } catch (e) {

          const message = e instanceof Error ? e.message : String(e);
          opencodeDbg("refreshModels:offline", {
            providerId,
            elapsedMs: Math.round(performance.now() - t0),
            message,
          });

          set({
            onlineStatusById: { ...get().onlineStatusById, [providerId]: "offline" },
            ...(silent ? {} : { error: message }),
          });

          throw e;

        } finally {

          if (!silent) {

            const next = { ...get().refreshingModelIds };

            delete next[providerId];

            set({ refreshingModelIds: next });

          }
          opencodeDbg("refreshModels:finally", {
            providerId,
            online: get().onlineStatusById[providerId],
            elapsedMs: Math.round(performance.now() - t0),
          });

        }
        })();

        refreshModelsInflight.set(providerId, run);
        try {
          return await run;
        } finally {
          refreshModelsInflight.delete(providerId);
        }

      },



      setProviderEnabled: async (id, enabled) => {
        if (!canUseAiBackend()) return false;
        const snapshot = get().providers;
        const onlineSnapshot = get().onlineStatusById;
        const prev = snapshot.find((p) => p.id === id);
        if (!prev) return false;

        // 乐观互斥：启用 A 时立刻关掉其它，避免 UI 短暂/持续显示多开
        const optimistic = snapshot.map((p) => {
          if (p.id === id) return { ...p, enabled };
          if (enabled && p.enabled) return { ...p, enabled: false };
          return p;
        });
        const onlinePatch: Record<string, CliProviderOnlineStatus> = { ...onlineSnapshot };
        for (const p of optimistic) {
          const installed = Boolean(p.binary?.trim());
          if (p.id === id && enabled && installed) {
            onlinePatch[p.id] = p.id === "opencode" ? "connecting" : "online";
          } else {
            onlinePatch[p.id] = deriveBaselineOnline(p, installed);
          }
        }
        set({ error: null, providers: optimistic, onlineStatusById: onlinePatch });
        for (const p of optimistic) {
          syncAcpEnabled(p.id, Boolean(p.enabled));
        }

        try {
          const res = await commands.cliProviderPatchCmd({ id, enabled });
          if (res.status === "ok") {
            const list = await commands.cliProviderListCmd();
            if (list.status === "ok") {
              const nextOnline = { ...get().onlineStatusById };
              for (const p of list.data) {
                const installed = Boolean(p.binary?.trim());
                // OpenCode 启用中由 refreshModels 写最终 online/offline
                if (!(p.id === id && enabled && installed && p.id === "opencode")) {
                  nextOnline[p.id] = deriveBaselineOnline(p, installed);
                }
                syncAcpEnabled(p.id, Boolean(p.enabled));
              }
              set({ providers: list.data, onlineStatusById: nextOnline });
            } else {
              set({ providers: upsertProvider(get().providers, res.data) });
              syncAcpEnabled(id, res.data.enabled ?? enabled);
            }
            if (enabled && res.data.binary) {
              opencodeDbg("setProviderEnabled:trigger refreshModels", {
                id,
                binary: res.data.binary,
              });
              // OpenCode：先启动 serve，再拉模型；Cursor：走 ACP 连接
              void (async () => {
                if (id === "opencode") {
                  try {
                    // 切到 OpenCode 时断开可能残留的 ACP（Cursor）
                    const { disconnectActiveAgent } = await import("../lib/acp/agentConnection");
                    await disconnectActiveAgent().catch(() => undefined);
                    await commands.opencodeEnsureService();
                  } catch (err) {
                    opencodeDbg("setProviderEnabled:ensure failed", err);
                  }
                } else if (id === "cursor") {
                  try {
                    await commands.opencodeStopService().catch(() => undefined);
                    // 确保检测结果就绪，再按「已启用」连接 ACP
                    const { useAcpServicesStore } = await import("./acpServicesStore");
                    const acp = useAcpServicesStore.getState();
                    if (acp.installStatuses.length === 0) {
                      await acp.refreshDetection();
                    }
                    const { connectActiveAcpAgent } = await import("../lib/acp/acpStream");
                    await connectActiveAcpAgent();
                  } catch (err) {
                    opencodeDbg("setProviderEnabled:cursor connect failed", err);
                  }
                }
                await get().refreshModels(id, { silent: true });
              })().catch((err) => {
                opencodeDbg("setProviderEnabled:refreshModels rejected", err);
              });
            } else if (!enabled) {
              if (id === "opencode") {
                void commands.opencodeStopService().catch(() => undefined);
              } else if (id === "cursor") {
                void import("../lib/acp/agentConnection")
                  .then(({ disconnectActiveAgent }) => disconnectActiveAgent())
                  .catch(() => undefined);
              }
              set({
                onlineStatusById: {
                  ...get().onlineStatusById,
                  [id]: Boolean(res.data.binary?.trim()) ? "idle" : "offline",
                },
              });
            }
            return true;
          }

          set({ providers: snapshot, error: res.error, onlineStatusById: onlineSnapshot });
          for (const p of snapshot) {
            syncAcpEnabled(p.id, Boolean(p.enabled));
          }
          return false;
        } catch (e) {
          set({
            providers: snapshot,
            onlineStatusById: onlineSnapshot,
            error: e instanceof Error ? e.message : String(e),
          });
          for (const p of snapshot) {
            syncAcpEnabled(p.id, Boolean(p.enabled));
          }
          return false;
        }
      },



      setModelEnabled: async (providerId, modelName, enabled) => {

        if (!canUseAiBackend()) return false;

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

      storage: createJSONStorage(createSafeLocalStorage),

      partialize: (state) => ({

        providers: state.providers,

        modelCache: state.modelCache,

      }),

    },

  ),

);

export async function initCliProvidersStore(): Promise<void> {
  // 启动时不拉取智能体，使用 localStorage 缓存；进入设置页时再 sync
}


