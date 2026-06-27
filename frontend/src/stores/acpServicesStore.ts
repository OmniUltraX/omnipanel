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

/** @deprecated 使用 AgentKind */
export type AcpService = {
  id: AgentKind;
  name: string;
  executablePath: string;
  modelSelectionId: string | null;
  isActive: boolean;
  builtin?: boolean;
  createdAt: number;
};

interface AcpServicesState {
  services: AcpService[];
  installStatuses: AgentInstallStatus[];
  detecting: boolean;
  setActive: (kind: AgentKind) => void;
  updateService: (id: AgentKind, patch: Partial<Pick<AcpService, "modelSelectionId">>) => void;
  setInstallStatuses: (statuses: AgentInstallStatus[]) => void;
  refreshDetection: () => Promise<void>;
  resetServices: () => void;
}

function defaultModelId(): string | null {
  return resolveAcpModelSelectionId(null);
}

function createService(kind: AgentKind, isActive: boolean, status?: AgentInstallStatus): AcpService {
  return {
    id: kind,
    name: kind,
    executablePath: status?.executablePath ?? "",
    modelSelectionId: defaultModelId(),
    isActive,
    createdAt: 0,
    builtin: kind === DEFAULT_AGENT_KIND,
  };
}

function buildDefaultServices(
  activeKind: AgentKind,
  statuses: AgentInstallStatus[],
): AcpService[] {
  return SUPPORTED_AGENT_KINDS.map((kind) => {
    const status = statuses.find((item) => item.kind === kind);
    return createService(kind, kind === activeKind, status);
  });
}

function normalizeActiveKind(services: AcpService[]): AgentKind {
  const active = services.find((s) => s.isActive);
  if (active && isSupportedAgentKind(active.id)) {
    return active.id;
  }
  if (services.some((s) => s.id === DEFAULT_AGENT_KIND)) {
    return DEFAULT_AGENT_KIND;
  }
  const installed = services.find((s) => s.executablePath.trim());
  if (installed && isSupportedAgentKind(installed.id)) {
    return installed.id;
  }
  return DEFAULT_AGENT_KIND;
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

/** 内置 Agent（OmniAgent）。 */
export function isBuiltinAcpService(service: AcpService): boolean {
  return service.id === "omniagent";
}

export const useAcpServicesStore = create<AcpServicesState>()(
  persist(
    (set, get) => ({
      services: buildDefaultServices(DEFAULT_AGENT_KIND, []),
      installStatuses: [],
      detecting: false,

      setActive: (kind) => {
        set({
          services: get().services.map((s) => ({
            ...s,
            isActive: s.id === kind,
          })),
        });
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
        const activeKind = normalizeActiveKind(get().services);
        set({
          installStatuses: statuses,
          services: buildDefaultServices(activeKind, statuses).map((service) => {
            const prev = get().services.find((s) => s.id === service.id);
            return {
              ...service,
              modelSelectionId: prev?.modelSelectionId ?? service.modelSelectionId,
              isActive: service.id === activeKind,
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
          services: buildDefaultServices(DEFAULT_AGENT_KIND, []),
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
          isActive: s.isActive,
        })),
      }),
      merge: (persisted, current) => {
        const raw = persisted as { services?: Array<{ id?: string; modelSelectionId?: string | null; isActive?: boolean }> } | undefined;
        const savedActive =
          raw?.services?.find((s) => s.isActive && isSupportedAgentKind(s.id ?? ""))?.id ??
          DEFAULT_AGENT_KIND;
        const activeKind = isSupportedAgentKind(savedActive) ? savedActive : DEFAULT_AGENT_KIND;
        const services = buildDefaultServices(activeKind as AgentKind, current.installStatuses);
        if (raw?.services) {
          for (const saved of raw.services) {
            if (!saved.id || !isSupportedAgentKind(saved.id)) continue;
            const idx = services.findIndex((s) => s.id === saved.id);
            if (idx >= 0) {
              services[idx] = {
                ...services[idx],
                modelSelectionId: saved.modelSelectionId ?? services[idx].modelSelectionId,
                isActive: saved.id === activeKind,
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
    services = buildDefaultServices(DEFAULT_AGENT_KIND, installStatuses);
  }

  services = services
    .filter((s) => isSupportedAgentKind(s.id))
    .map((s) => ({
      ...createService(s.id, s.isActive, installStatuses.find((st) => st.kind === s.id)),
      modelSelectionId: s.modelSelectionId ?? defaultModelId,
      isActive: s.isActive,
    }));

  if (!services.some((s) => s.isActive)) {
    const fallback = normalizeActiveKind(services);
    services = services.map((s) => ({ ...s, isActive: s.id === fallback }));
  }

  useAcpServicesStore.setState({ services });
  await useAcpServicesStore.getState().refreshDetection();
}

export function getActiveAcpService(services: AcpService[]): AcpService | null {
  return services.find((s) => s.isActive) ?? services[0] ?? null;
}

export function getActiveAgentKind(services: AcpService[]): AgentKind {
  const active = getActiveAcpService(services);
  return active && isSupportedAgentKind(active.id) ? active.id : DEFAULT_AGENT_KIND;
}

export { agentKindToServiceId, SUPPORTED_AGENT_KINDS };
