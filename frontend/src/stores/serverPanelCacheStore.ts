import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Connection } from "../ipc/bindings";
import { connectionToServerEntry } from "../modules/server/panel/panelConnection";
import {
  EMPTY_SERVER_PANEL_RESOURCE_CACHE,
  type ServerPanelCacheServerMeta,
  type ServerPanelResourceCache,
} from "../modules/server/panel/serverPanelCache";
import { fetchServerPanelResources } from "../modules/server/panel/serverPanelCacheRefresh";

/**
 * 第三方服务 / 服务器面板本地缓存：
 * - panelServers：面板实例列表（从 connectionStore 同步，读路径一律走本 store）
 * - resourcesByServerId：各面板的网站 / 证书远程数据
 * 写路径：刷新按钮 / 单面板 refresh；业务变更后可调用 refreshServer。
 */
type ServerPanelCacheState = {
  panelServers: ServerPanelCacheServerMeta[];
  resourcesByServerId: Record<string, ServerPanelResourceCache>;
  refreshing: boolean;
  refreshingServerIds: Record<string, true>;
  /** 从本地连接缓存同步面板列表（不访问远端面板 API） */
  syncPanelServersFromConnections: (connections: Connection[]) => void;
  getResources: (serverId: string) => ServerPanelResourceCache;
  isServerRefreshing: (serverId: string) => boolean;
  removeServer: (serverId: string) => void;
  refreshServer: (server: ServerPanelCacheServerMeta) => Promise<ServerPanelResourceCache>;
  refreshAllResources: (servers?: ServerPanelCacheServerMeta[]) => Promise<void>;
};

const EMPTY_PANEL_SERVERS: ServerPanelCacheServerMeta[] = [];
const inflightByServerId = new Map<string, Promise<ServerPanelResourceCache>>();

function toMeta(server: ServerPanelCacheServerMeta): ServerPanelCacheServerMeta {
  return {
    id: server.id,
    name: server.name,
    address: server.address,
    key: server.key,
    serviceType: server.serviceType,
    createdAt: server.createdAt,
  };
}

function panelServersEqual(
  a: ServerPanelCacheServerMeta[],
  b: ServerPanelCacheServerMeta[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.address !== right.address ||
      left.key !== right.key ||
      left.serviceType !== right.serviceType ||
      left.createdAt !== right.createdAt
    ) {
      return false;
    }
  }
  return true;
}

export const useServerPanelCacheStore = create<ServerPanelCacheState>()(
  persist(
    (set, get) => ({
      panelServers: EMPTY_PANEL_SERVERS,
      resourcesByServerId: {},
      refreshing: false,
      refreshingServerIds: {},

      syncPanelServersFromConnections: (connections) => {
        const next = connections
          .filter((c) => c.kind === "panel")
          .map((c) => toMeta(connectionToServerEntry(c)))
          .sort((a, b) => a.name.localeCompare(b.name));
        const prev = get().panelServers;
        if (panelServersEqual(prev, next)) return;

        const validIds = new Set(next.map((s) => s.id));
        set((state) => {
          const resourcesByServerId = { ...state.resourcesByServerId };
          for (const id of Object.keys(resourcesByServerId)) {
            if (!validIds.has(id)) {
              delete resourcesByServerId[id];
            }
          }
          return { panelServers: next, resourcesByServerId };
        });
      },

      getResources: (serverId) =>
        get().resourcesByServerId[serverId] ?? EMPTY_SERVER_PANEL_RESOURCE_CACHE,

      isServerRefreshing: (serverId) => Boolean(get().refreshingServerIds[serverId]),

      removeServer: (serverId) => {
        set((state) => {
          if (!state.resourcesByServerId[serverId] && !state.panelServers.some((s) => s.id === serverId)) {
            return state;
          }
          const resourcesByServerId = { ...state.resourcesByServerId };
          delete resourcesByServerId[serverId];
          return {
            panelServers: state.panelServers.filter((s) => s.id !== serverId),
            resourcesByServerId,
          };
        });
      },

      refreshServer: async (server) => {
        const serverId = server.id;
        const existing = inflightByServerId.get(serverId);
        if (existing) return existing;

        const run = (async () => {
          set((state) => ({
            refreshingServerIds: { ...state.refreshingServerIds, [serverId]: true },
          }));
          try {
            const entry = await fetchServerPanelResources(toMeta(server));
            set((state) => ({
              resourcesByServerId: {
                ...state.resourcesByServerId,
                [serverId]: entry,
              },
            }));
            return entry;
          } finally {
            set((state) => {
              const refreshingServerIds = { ...state.refreshingServerIds };
              delete refreshingServerIds[serverId];
              return { refreshingServerIds };
            });
            inflightByServerId.delete(serverId);
          }
        })();

        inflightByServerId.set(serverId, run);
        return run;
      },

      refreshAllResources: async (servers) => {
        const list = servers ?? get().panelServers;
        set({ refreshing: true });
        try {
          await Promise.all(list.map((server) => get().refreshServer(server)));
        } finally {
          set({ refreshing: false });
        }
      },
    }),
    {
      name: "omnipanel-server-panel-cache.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        panelServers: state.panelServers,
        resourcesByServerId: state.resourcesByServerId,
      }),
    },
  ),
);
