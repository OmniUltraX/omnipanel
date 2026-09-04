import { create } from "zustand";

import { asArray } from "@/ipc/asArray";
import {
  commands,
  type CapabilityProbeResult,
  type InstallToolResult,
  type RemoteToolCapability,
} from "@/ipc/bindings";
import { formatIpcError, unwrapCommand } from "@/ipc/result";
import { noteSshAuthFailure, sshAuthHeldMessage } from "../sshAuthHold";

/** Web 软降级可能返回 `[]`/`{}`；规范成带 `tools: []` 的探测结果，避免 `.tools` 迭代崩溃。 */
function normalizeProbeResult(
  resourceId: string,
  raw: unknown,
): CapabilityProbeResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      resourceId,
      tools: [],
      elapsedMs: 0,
      probedAt: 0,
      lazyProbeIds: [],
    };
  }
  const obj = raw as Partial<CapabilityProbeResult>;
  return {
    resourceId: String(obj.resourceId || resourceId),
    tools: asArray<RemoteToolCapability>(obj.tools),
    elapsedMs: typeof obj.elapsedMs === "number" ? obj.elapsedMs : 0,
    probedAt: typeof obj.probedAt === "number" ? obj.probedAt : 0,
    lazyProbeIds: asArray<string>(obj.lazyProbeIds),
  };
}

/** 单台主机的探测态。 */
export type ResourceCapabilities = {
  /** 最近一次探测结果，null 表示尚未探测过。 */
  result: CapabilityProbeResult | null;
  loading: boolean;
  error: string | null;
  /** 正在安装的工具 id 集合，用于禁用对应按钮。 */
  installing: Record<string, boolean>;
};

const EMPTY_ENTRY: ResourceCapabilities = {
  result: null,
  loading: false,
  error: null,
  installing: {},
};

type State = {
  entries: Record<string, ResourceCapabilities>;
  /** 探测远端能力。后端已有 5 分钟 TTL，force=true 时跳过缓存。 */
  probe: (resourceId: string, force?: boolean) => Promise<CapabilityProbeResult | null>;
  /** 安装单个工具；成功后用后端返回的 state 原地更新缓存条目。 */
  installTool: (resourceId: string, toolId: string) => Promise<InstallToolResult | null>;
  /** 失效缓存（安装后或手动触发）。 */
  invalidate: (resourceId: string) => Promise<void>;
  /** 清空全部缓存（切换主机批次等场景）。 */
  clear: () => void;
};

function ensureEntry(entries: Record<string, ResourceCapabilities>, resourceId: string) {
  return entries[resourceId] ?? EMPTY_ENTRY;
}

/**
 * 远端工具能力缓存 store。
 *
 * 后端已按 resource_id 缓存探测结果（TTL 5 分钟），前端这层主要承载：
 * - 跨 Tab 切换时不重复探测（共享同一份结果）；
 * - 安装单个工具后原地更新该工具状态（避免全量重探）；
 * - 安装中按钮禁用态。
 */
export const useCapabilitiesStore = create<State>((set) => ({
  entries: {},

  probe: async (resourceId, force = false) => {
    const heldMessage = !force ? sshAuthHeldMessage(resourceId) : null;
    if (heldMessage) {
      set((state) => ({
        entries: {
          ...state.entries,
          [resourceId]: {
            ...ensureEntry(state.entries, resourceId),
            loading: false,
            error: state.entries[resourceId]?.error ?? heldMessage,
          },
        },
      }));
      return null;
    }
    set((state) => ({
      entries: {
        ...state.entries,
        [resourceId]: {
          ...ensureEntry(state.entries, resourceId),
          loading: true,
          error: null,
        },
      },
    }));
    try {
      const raw = await unwrapCommand(
        commands.sshPoolProbeCapabilities(resourceId, force),
      );
      const result = normalizeProbeResult(resourceId, raw);
      set((state) => ({
        entries: {
          ...state.entries,
          [resourceId]: { ...ensureEntry(state.entries, resourceId), result, loading: false },
        },
      }));
      return result;
    } catch (err) {
      noteSshAuthFailure(resourceId, err);
      const message = formatIpcError(err);
      set((state) => ({
        entries: {
          ...state.entries,
          [resourceId]: {
            ...ensureEntry(state.entries, resourceId),
            loading: false,
            error: message,
          },
        },
      }));
      return null;
    }
  },

  installTool: async (resourceId, toolId) => {
    set((state) => ({
      entries: {
        ...state.entries,
        [resourceId]: {
          ...ensureEntry(state.entries, resourceId),
          installing: { ...ensureEntry(state.entries, resourceId).installing, [toolId]: true },
        },
      },
    }));
    try {
      const res = await unwrapCommand(
        commands.sshPoolInstallTool(resourceId, toolId),
      );
      // 后端已重新探测该工具状态并失效缓存，这里原地更新前端缓存条目
      set((state) => {
        const entry = ensureEntry(state.entries, resourceId);
        const result = entry.result;
        if (result && res.state) {
          const tools = asArray<RemoteToolCapability>(result.tools).map((tool) =>
            tool.id === toolId ? { ...tool, state: res.state! } : tool,
          );
          return {
            entries: {
              ...state.entries,
              [resourceId]: {
                ...entry,
                result: { ...result, tools },
                installing: { ...entry.installing, [toolId]: false },
              },
            },
          };
        }
        return {
          entries: {
            ...state.entries,
            [resourceId]: {
              ...entry,
              installing: { ...entry.installing, [toolId]: false },
            },
          },
        };
      });
      return res;
    } catch (err) {
      set((state) => {
        const entry = ensureEntry(state.entries, resourceId);
        return {
          entries: {
            ...state.entries,
            [resourceId]: {
              ...entry,
              installing: { ...entry.installing, [toolId]: false },
              error: formatIpcError(err),
            },
          },
        };
      });
      return null;
    }
  },

  invalidate: async (resourceId) => {
    try {
      await unwrapCommand(commands.sshPoolInvalidateCapabilities(resourceId));
    } catch {
      // 后端失效失败不阻塞，前端仍可强制重探
    }
    set((state) => ({
      entries: {
        ...state.entries,
        [resourceId]: { ...ensureEntry(state.entries, resourceId), result: null },
      },
    }));
  },

  clear: () => set({ entries: {} }),
}));

/** 读取某主机的缓存条目（未探测时返回空态）。 */
export function selectCapabilities(
  state: State,
  resourceId: string | null,
): ResourceCapabilities {
  if (!resourceId) return EMPTY_ENTRY;
  return state.entries[resourceId] ?? EMPTY_ENTRY;
}
