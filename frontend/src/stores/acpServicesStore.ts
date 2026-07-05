import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { detectAllAgents } from "../lib/agents/detect";
import type { AgentInstallStatus, AgentKind } from "../lib/agents/types";
import { agentKindToServiceId, DEFAULT_AGENT_KIND, isSupportedAgentKind, SUPPORTED_AGENT_KINDS } from "../lib/agents/types";
import {
  firstModelSelectionId,
  resolveModelSelection,
  useAiModelsStore,
} from "./aiModelsStore";
import { useSettingsStore } from "./settingsStore";

/** CLI 对话提供者（原 ACP Agent）。 */
export type AcpService = {
  id: AgentKind;
  name: string;
  executablePath: string;
  modelSelectionId: string | null;
  /** 多启用：是否开启该 CLI 提供者 */
  enabled: boolean;
  /** @deprecated 兼容旧数据，等同首个 enabled */
  isActive: boolean;
  builtin?: boolean;
  createdAt: number;
};

interface AcpServicesState {
  services: AcpService[];
  installStatuses: AgentInstallStatus[];
  detecting: boolean;
  toggleEnabled: (kind: AgentKind) => void;
  /** @deprecated 使用 toggleEnabled */
  setActive: (kind: AgentKind) => void;
  updateService: (id: AgentKind, patch: Partial<Pick<AcpService, "modelSelectionId">>) => void;
  setInstallStatuses: (statuses: AgentInstallStatus[]) => void;
  refreshDetection: () => Promise<void>;
  resetServices: () => void;
}

function defaultModelId(): string | null {
  return resolveAcpModelSelectionId(null);
}

function createService(
  kind: AgentKind,
  enabled: boolean,
  status?: AgentInstallStatus,
): AcpService {
  return {
    id: kind,
    name: kind,
    executablePath: status?.executablePath ?? "",
    modelSelectionId: defaultModelId(),
    enabled,
    isActive: enabled,
    createdAt: 0,
    builtin: kind === DEFAULT_AGENT_KIND,
  };
}

function buildDefaultServices(
  enabledKinds: Set<AgentKind>,
  statuses: AgentInstallStatus[],
): AcpService[] {
  return SUPPORTED_AGENT_KINDS.map((kind) => {
    const status = statuses.find((item) => item.kind === kind);
    const enabled = enabledKinds.has(kind);
    return createService(kind, enabled, status);
  });
}

function normalizeEnabledKinds(services: AcpService[]): Set<AgentKind> {
  const enabled = new Set<AgentKind>();
  for (const s of services) {
    if ((s.enabled ?? s.isActive) && isSupportedAgentKind(s.id)) {
      enabled.add(s.id);
    }
  }
  return enabled;
}

export function resolveAcpModelSelectionId(active: AcpService | null): string | null {
  const providers = useAiModelsStore.getState().providers;
  const fromService = active?.modelSelectionId?.trim();
  if (fromService && resolveModelSelection(providers, fromService)) {
    return fromService;
  }

  const assistantId = useSettingsStore.getState().aiScenarioAssistantModelSelectionId;
  if (assistantId && resolveModelSelection(providers, assistantId)) {
    return assistantId;
  }

  return firstModelSelectionId(providers);
}

export function isBuiltinAcpService(service: AcpService): boolean {
  return service.id === "omniagent";
}

export const useAcpServicesStore = create<AcpServicesState>()(
  persist(
    (set, get) => ({
      services: buildDefaultServices(new Set(), []),
      installStatuses: [],
      detecting: false,

      toggleEnabled: (kind) => {
        set({
          services: get().services.map((s) => {
            if (s.id !== kind) return s;
            const enabled = !s.enabled;
            return { ...s, enabled, isActive: enabled };
          }),
        });
      },

      setActive: (kind) => {
        get().toggleEnabled(kind);
      },

      updateService: (id, patch) => {
        set({
          services: get().services.map((s) =>
            s.id === id
              ? {
                  ...s,
                  ...(patch.modelSelectionId !== undefined
                    ? {
                        modelSelectionId:
                          patch.modelSelectionId && patch.modelSelectionId.trim()
                            ? patch.modelSelectionId.trim()
                            : null,
                      }
                    : {}),
                }
              : s,
          ),
        });
      },

      setInstallStatuses: (statuses) => {
        const enabledKinds = normalizeEnabledKinds(get().services);
        set({
          installStatuses: statuses,
          services: buildDefaultServices(enabledKinds, statuses).map((service) => {
            const prev = get().services.find((s) => s.id === service.id);
            return {
              ...service,
              modelSelectionId: prev?.modelSelectionId ?? service.modelSelectionId,
              enabled: prev?.enabled ?? service.enabled,
              isActive: prev?.enabled ?? service.enabled,
            };
          }),
        });
      },

      refreshDetection: async () => {
        set({ detecting: true });
        try {
          const statuses = await detectAllAgents();
          get().setInstallStatuses(statuses);
        } finally {
          set({ detecting: false });
        }
      },

      resetServices: () => {
        set({
          services: buildDefaultServices(new Set(), []),
          installStatuses: [],
        });
      },
    }),
    {
      name: "omnipanel-acp-services",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        services: state.services.map((s) => ({
          id: s.id,
          modelSelectionId: s.modelSelectionId,
          enabled: s.enabled ?? s.isActive,
          isActive: s.enabled ?? s.isActive,
        })),
      }),
      merge: (persisted, current) => {
        const raw = persisted as {
          services?: Array<{
            id?: string;
            modelSelectionId?: string | null;
            enabled?: boolean;
            isActive?: boolean;
          }>;
        } | undefined;
        const enabledKinds = new Set<AgentKind>();
        if (raw?.services) {
          for (const saved of raw.services) {
            if (!saved.id || !isSupportedAgentKind(saved.id)) continue;
            if (saved.enabled ?? saved.isActive) {
              enabledKinds.add(saved.id as AgentKind);
            }
          }
        }
        const services = buildDefaultServices(enabledKinds, current.installStatuses);
        if (raw?.services) {
          for (const saved of raw.services) {
            if (!saved.id || !isSupportedAgentKind(saved.id)) continue;
            const idx = services.findIndex((s) => s.id === saved.id);
            if (idx >= 0) {
              const enabled = saved.enabled ?? saved.isActive ?? false;
              services[idx] = {
                ...services[idx],
                modelSelectionId: saved.modelSelectionId ?? services[idx].modelSelectionId,
                enabled,
                isActive: enabled,
              };
            }
          }
        }
        return { ...current, services };
      },
    },
  ),
);

export async function initAcpServicesStore(): Promise<void> {
  const defaultModelId = resolveAcpModelSelectionId(null);
  let { services, installStatuses } = useAcpServicesStore.getState();

  if (!services.some((s) => isSupportedAgentKind(s.id))) {
    services = buildDefaultServices(new Set(), installStatuses);
  }

  services = services
    .filter((s) => isSupportedAgentKind(s.id))
    .map((s) => ({
      ...createService(s.id, s.enabled ?? s.isActive, installStatuses.find((st) => st.kind === s.id)),
      modelSelectionId: s.modelSelectionId ?? defaultModelId,
      enabled: s.enabled ?? s.isActive,
      isActive: s.enabled ?? s.isActive,
    }));

  useAcpServicesStore.setState({ services });
  // 启动时不自动检测本地 CLI Agent，进入设置页或手动刷新时再检测
}

export function getEnabledAcpServices(services: AcpService[]): AcpService[] {
  return services.filter((s) => s.enabled ?? s.isActive);
}

export function getActiveAcpService(services: AcpService[]): AcpService | null {
  return getEnabledAcpServices(services)[0] ?? services[0] ?? null;
}

export function getActiveAgentKind(services: AcpService[]): AgentKind {
  const active = getActiveAcpService(services);
  return active && isSupportedAgentKind(active.id) ? active.id : DEFAULT_AGENT_KIND;
}

export { agentKindToServiceId, SUPPORTED_AGENT_KINDS };
