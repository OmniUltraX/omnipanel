import { create } from "zustand";

/**
 * ACP（Agent Communication Protocol）服务配置项。
 * 每个服务指向一个本地可执行的 ACP 服务器应用，
 * 同时刻最多只有一个可被标记为「当前使用」。
 */
export interface AcpService {
  id: string;
  /** 显示名称（例如「本地 Claude」「公司内部 Agent」） */
  name: string;
  /** ACP 服务器应用的可执行文件绝对路径 */
  executablePath: string;
  /** 是否为当前使用的 ACP 服务；全局最多一个为 true */
  isActive: boolean;
  /** 创建时间（毫秒） */
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
  /** 把指定 id 标记为当前使用，其他自动取消 */
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

/** 开发/HMR 用的 localStorage 镜像缓存 */
const CACHE_LS_KEY = "omnipanel-acp-services-v1";

interface PersistedShape {
  version: number;
  services: AcpService[];
}

function readCache(): AcpService[] | null {
  try {
    const raw = window.localStorage.getItem(CACHE_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!Array.isArray(parsed.services)) return null;
    return parsed.services.map(normalizeLoaded);
  } catch (e) {
    console.warn("[acpServicesStore] 读取 localStorage 缓存失败:", e);
    return null;
  }
}

function writeCache(services: AcpService[]): void {
  try {
    window.localStorage.setItem(
      CACHE_LS_KEY,
      JSON.stringify({ version: 1, services }),
    );
  } catch (e) {
    console.warn("[acpServicesStore] 写入 localStorage 缓存失败:", e);
  }
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

/** 强制保证全局「同时只有一个 isActive 为 true」 */
function enforceSingleActive(services: AcpService[], preferredId?: string): AcpService[] {
  const activeCount = services.filter((s) => s.isActive).length;
  if (activeCount <= 1) return services;
  if (preferredId) {
    return services.map((s) => ({ ...s, isActive: s.id === preferredId }));
  }
  // 没有指定优先 id：保留最早创建的那个为 active
  const sortedActive = services
    .filter((s) => s.isActive)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
  const keepId = sortedActive[0]?.id;
  return services.map((s) => ({ ...s, isActive: s.id === keepId }));
}

export const useAcpServicesStore = create<AcpServicesState>()((set, get) => ({
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
    writeCache(merged);
    return merged.find((s) => s.id === created.id) ?? created;
  },
  removeService: (id) => {
    const next = get().services.filter((s) => s.id !== id);
    set({ services: next });
    writeCache(next);
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
    writeCache(enforced);
  },
  setActive: (id) => {
    const target = get().services.find((s) => s.id === id);
    if (!target) return;
    const next = get().services.map((s) => ({ ...s, isActive: s.id === id }));
    set({ services: next });
    writeCache(next);
  },
  resetServices: () => {
    set({ services: [] });
    writeCache([]);
  },
}));

const HMR_STATE_KEY = "acpServices";

if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    data[HMR_STATE_KEY] = useAcpServicesStore.getState().services;
  });

  const hmrServices = import.meta.hot.data[HMR_STATE_KEY] as AcpService[] | undefined;
  if (hmrServices?.length) {
    const normalized = enforceSingleActive(hmrServices.map(normalizeLoaded));
    useAcpServicesStore.setState({ services: normalized });
  } else {
    const cached = readCache();
    if (cached && cached.length > 0) {
      const normalized = enforceSingleActive(cached);
      useAcpServicesStore.setState({ services: normalized });
    }
  }
}

/** 应用启动时调用：从 localStorage 恢复（如未在 HMR 阶段恢复） */
export function initAcpServicesStore(force = false): void {
  if (!force && useAcpServicesStore.getState().services.length > 0) {
    return;
  }
  const cached = readCache();
  if (cached && cached.length > 0) {
    const normalized = enforceSingleActive(cached);
    useAcpServicesStore.setState({ services: normalized });
  } else if (useAcpServicesStore.getState().services.length === 0) {
    useAcpServicesStore.setState({ services: [] });
  }
}

/** 显式持久化当前 store 内容（一般无需调用）。 */
export function persistAcpServicesStore(): void {
  writeCache(useAcpServicesStore.getState().services);
}

/** 获取当前激活的 ACP 服务；无则返回 null */
export function getActiveAcpService(services: AcpService[]): AcpService | null {
  return services.find((s) => s.isActive) ?? null;
}
