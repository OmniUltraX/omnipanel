import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface AcpService {
  id: string;
  name: string;
  executablePath: string;
  isActive: boolean;
  createdAt: number;
}

interface AcpServicesState {
  services: AcpService[];
  addService: (
    input: Omit<AcpService, "id" | "createdAt" | "isActive"> & {
      isActive?: boolean;
    },
  ) => AcpService;
  removeService: (id: string) => void;
  updateService: (
    id: string,
    patch: Partial<Omit<AcpService, "id" | "createdAt">>,
  ) => void;
  setActive: (id: string) => void;
  resetServices: () => void;
}

let idCounter = 0;

function genId(): string {
  return `acp_${Date.now()}_${++idCounter}`;
}

function normalizeName(name: string): string {
  return name.trim();
}

function normalizePath(path: string): string {
  return path.trim();
}

function normalizeLoaded(s: AcpService): AcpService {
  return {
    id: s.id,
    name: normalizeName(s.name ?? ""),
    executablePath: normalizePath(s.executablePath ?? ""),
    isActive: Boolean(s.isActive),
    createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
  };
}

function enforceSingleActive(services: AcpService[], preferredId?: string): AcpService[] {
  const activeCount = services.filter((s) => s.isActive).length;
  if (activeCount <= 1) return services;
  if (preferredId) {
    return services.map((s) => ({ ...s, isActive: s.id === preferredId }));
  }
  const sortedActive = services
    .filter((s) => s.isActive)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
  const keepId = sortedActive[0]?.id;
  return services.map((s) => ({ ...s, isActive: s.id === keepId }));
}

export const useAcpServicesStore = create<AcpServicesState>()(
  persist(
    (set, get) => ({
      services: [],
      addService: (input) => {
        const isActive = Boolean(input.isActive);
        const created: AcpService = {
          id: genId(),
          name: normalizeName(input.name),
          executablePath: normalizePath(input.executablePath),
          isActive,
          createdAt: Date.now(),
        };
        const merged = enforceSingleActive([...get().services, created], created.id);
        set({ services: merged });
        return merged.find((s) => s.id === created.id) ?? created;
      },
      removeService: (id) => {
        const next = get().services.filter((s) => s.id !== id);
        set({ services: next });
      },
      updateService: (id, patch) => {
        const next = get().services.map((s) => {
          if (s.id !== id) return s;
          return {
            ...s,
            ...patch,
            ...(patch.name !== undefined ? { name: normalizeName(patch.name) } : {}),
            ...(patch.executablePath !== undefined
              ? { executablePath: normalizePath(patch.executablePath) }
              : {}),
          };
        });
        const enforced = enforceSingleActive(next, id);
        set({ services: enforced });
      },
      setActive: (id) => {
        const target = get().services.find((s) => s.id === id);
        if (!target) return;
        const next = get().services.map((s) => ({ ...s, isActive: s.id === id }));
        set({ services: next });
      },
      resetServices: () => {
        set({ services: [] });
      },
    }),
    {
      name: "omnipanel-acp-services",
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const raw = persisted as { services?: unknown[] } | undefined;
        if (!raw?.services) return current;
        return { services: raw.services.map(normalizeLoaded) };
      },
    },
  ),
);

export function initAcpServicesStore(): void {
  const { services } = useAcpServicesStore.getState();
  if (services.length > 0) {
    const normalized = enforceSingleActive(services);
    useAcpServicesStore.setState({ services: normalized });
  }
}

export function getActiveAcpService(services: AcpService[]): AcpService | null {
  return services.find((s) => s.isActive) ?? null;
}
