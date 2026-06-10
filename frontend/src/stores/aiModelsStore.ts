import { create } from "zustand";

import { commands } from "../ipc/bindings";

/** 用户自定义的 AI 模型接入方式 */
export type ApiStandard = "openai" | "anthropic";

/** 一个提供商配置，可包含多个模型名称 */
export interface AiModelProvider {
  id: string;
  /** 提供商显示名称 */
  providerName: string;
  /** API 标准：决定请求体格式与默认 BaseURL */
  apiStandard: ApiStandard;
  /** 接口 Base URL（去掉末尾斜杠后保存） */
  baseUrl: string;
  /** API Key（在 UI 中掩码显示） */
  apiKey: string;
  /** 该提供商下的模型名称列表 */
  modelNames: string[];
  /** 创建时间（毫秒） */
  createdAt: number;
}

/** @deprecated 旧版扁平模型结构，仅用于一次性数据迁移 */
interface LegacyAiModelConfig {
  id: string;
  name: string;
  apiStandard: ApiStandard;
  baseUrl: string;
  apiKey: string;
  createdAt: number;
}

interface AiModelsState {
  providers: AiModelProvider[];
  addProvider: (input: Omit<AiModelProvider, "id" | "createdAt">) => AiModelProvider;
  removeProvider: (id: string) => void;
  updateProvider: (
    id: string,
    patch: Partial<Omit<AiModelProvider, "id" | "createdAt">>
  ) => void;
  resetProviders: () => void;
}

let idCounter = 0;
function genId(): string {
  return `provider_${Date.now()}_${++idCounter}`;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function normalizeProviderName(name: string): string {
  return name.trim();
}

function normalizeModelNames(names: string[]): string[] {
  return names.map((n) => n.trim()).filter(Boolean);
}

function migrateLegacyModels(models: LegacyAiModelConfig[]): AiModelProvider[] {
  const groups = new Map<
    string,
    {
      apiStandard: ApiStandard;
      baseUrl: string;
      apiKey: string;
      createdAt: number;
      modelNames: string[];
    }
  >();

  for (const model of models) {
    const key = `${model.apiStandard}\0${model.baseUrl}\0${model.apiKey}`;
    const group = groups.get(key);
    if (group) {
      group.modelNames.push(model.name);
      group.createdAt = Math.min(group.createdAt, model.createdAt);
    } else {
      groups.set(key, {
        apiStandard: model.apiStandard,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        createdAt: model.createdAt,
        modelNames: [model.name],
      });
    }
  }

  return Array.from(groups.values()).map((group) => ({
    id: genId(),
    providerName: group.modelNames[0] ?? "默认提供商",
    apiStandard: group.apiStandard,
    baseUrl: group.baseUrl,
    apiKey: group.apiKey,
    modelNames: group.modelNames,
    createdAt: group.createdAt,
  }));
}

/** 旧版 localStorage 键（迁移完成后清除） */
const LEGACY_LS_KEY = "omnipanel-ai-models";

/** 旧版 localStorage 中保存的负载形态 */
interface LegacyPersistedState {
  state?: { providers?: AiModelProvider[]; models?: LegacyAiModelConfig[] };
  version?: number;
}

/** 从旧版 localStorage 读取并转换为新的 Provider 结构。无旧数据返回 null。 */
function readLegacyFromLocalStorage(): AiModelProvider[] | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LegacyPersistedState;
    if (parsed.version === 2 && Array.isArray(parsed.state?.providers)) {
      return parsed.state.providers;
    }
    if (Array.isArray(parsed.state?.models)) {
      return migrateLegacyModels(parsed.state.models);
    }
    return null;
  } catch (e) {
    console.warn("[aiModelsStore] 读取旧版 localStorage 数据失败:", e);
    return null;
  }
}

function clearLegacyLocalStorage() {
  try {
    window.localStorage.removeItem(LEGACY_LS_KEY);
  } catch {
    /* ignore */
  }
}

/** 放宽后的 provider 形态（apiStandard 是 string），来自 bindings。 */
interface LooseProvider {
  id: string;
  providerName: string;
  apiStandard: string;
  baseUrl: string;
  apiKey: string;
  modelNames: string[];
  createdAt: number;
}

/**
 * 把从 bindings 加载的宽类型收紧为 store 强类型。
 * apiStandard 不在已知枚举内时回落为 "openai"（最宽松的默认）。
 */
function toStrictProvider(p: LooseProvider): AiModelProvider {
  const std: ApiStandard = p.apiStandard === "anthropic" ? "anthropic" : "openai";
  return {
    id: p.id,
    providerName: p.providerName,
    apiStandard: std,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    modelNames: Array.isArray(p.modelNames) ? p.modelNames : [],
    createdAt: p.createdAt,
  };
}

function toStrictProviders(list: LooseProvider[] | undefined): AiModelProvider[] {
  if (!Array.isArray(list)) return [];
  return list.map(toStrictProvider);
}

/** 是否运行在 Tauri 环境中（纯 Vite 开发无 Tauri 时为 false） */
function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INVOKE__" in window;
}

/** 持久化当前 providers 数组到 ai-models.json。Tauri 不可用时静默跳过。 */
async function persistProviders(providers: AiModelProvider[]): Promise<void> {
  if (!hasTauri()) return;
  try {
    const res = await commands.aiModelsSave({ version: 1, providers });
    if (res.status === "error") {
      console.warn("[aiModelsStore] 写入磁盘失败:", res.error);
    }
  } catch (e) {
    console.warn("[aiModelsStore] 写入磁盘失败:", e);
  }
}

/**
 * 内存中保存状态。磁盘写盘由 initAiModelsStore 完成首次加载，
 * 之后由各 action（addProvider/removeProvider/updateProvider/resetProviders）
 * 在更新 store 后立即调用 `persistProviders(next)` 触发。
 */
export const useAiModelsStore = create<AiModelsState>()((set, get) => ({
  providers: [],
  addProvider: (input) => {
    const provider: AiModelProvider = {
      id: genId(),
      providerName: normalizeProviderName(input.providerName),
      apiStandard: input.apiStandard,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      apiKey: input.apiKey.trim(),
      modelNames: normalizeModelNames(input.modelNames),
      createdAt: Date.now(),
    };
    const next = [provider, ...get().providers];
    set({ providers: next });
    void persistProviders(next);
    return provider;
  },
  removeProvider: (id) => {
    const next = get().providers.filter((p) => p.id !== id);
    set({ providers: next });
    void persistProviders(next);
  },
  updateProvider: (id, patch) => {
    const next = get().providers.map((p) =>
      p.id === id
        ? {
            ...p,
            ...patch,
            ...(patch.providerName !== undefined
              ? { providerName: normalizeProviderName(patch.providerName) }
              : {}),
            ...(patch.baseUrl !== undefined
              ? { baseUrl: normalizeBaseUrl(patch.baseUrl) }
              : {}),
            ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey.trim() } : {}),
            ...(patch.modelNames !== undefined
              ? { modelNames: normalizeModelNames(patch.modelNames) }
              : {}),
          }
        : p
    );
    set({ providers: next });
    void persistProviders(next);
  },
  resetProviders: () => {
    set({ providers: [] });
    void persistProviders([]);
  },
}));

/**
 * 应用启动时调用一次：
 *  1. 若磁盘文件为空,尝试从旧版 localStorage 迁移一次性数据；
 *  2. 将磁盘内容载入内存。
 */
export async function initAiModelsStore(): Promise<void> {
  if (!hasTauri()) return;
  try {
    const res = await commands.aiModelsLoad();
    if (res.status !== "ok") {
      console.warn("[aiModelsStore] 加载失败:", res.error);
      return;
    }
    const file = res.data;
    if ((file.providers?.length ?? 0) === 0) {
      const legacy = readLegacyFromLocalStorage();
      if (legacy && legacy.length > 0) {
        const saveRes = await commands.aiModelsSave({ version: 1, providers: legacy });
        if (saveRes.status === "ok") {
          useAiModelsStore.setState({ providers: legacy });
          console.info(
            `[aiModelsStore] 已从 localStorage 迁移 ${legacy.length} 个 AI 提供商到磁盘`
          );
        } else {
          console.warn("[aiModelsStore] 迁移写入失败:", saveRes.error);
        }
      } else {
        useAiModelsStore.setState({ providers: [] });
      }
      clearLegacyLocalStorage();
    } else {
      useAiModelsStore.setState({ providers: toStrictProviders(file.providers) });
    }
  } catch (e) {
    console.warn("[aiModelsStore] 初始化加载失败:", e);
  }
}

/** 显式持久化当前 store 内容（一般无需调用，action 已自动落盘）。 */
export async function persistAiModelsStore(): Promise<void> {
  const { providers } = useAiModelsStore.getState();
  await persistProviders(providers);
}

/** 掩码显示 API Key：仅保留最后 4 个可见字符 */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "•".repeat(key.length);
  return `••••${key.slice(-4)}`;
}

/** 根据 API 标准推断的默认 BaseURL */
export function defaultBaseUrlFor(standard: ApiStandard): string {
  switch (standard) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    default:
      return "";
  }
}

/** 简单的 URL 合法性校验 */
export function isValidBaseUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 解析逗号分隔的模型名称（去空白、去重，不区分大小写） */
export function parseModelNames(
  input: string
): { ok: true; names: string[] } | { ok: false; duplicate: string } {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of input.split(",")) {
    const name = part.trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      return { ok: false, duplicate: name };
    }
    seen.add(lower);
    names.push(name);
  }
  return { ok: true, names };
}

/** 模型选择 ID 分隔符（providerId + modelName） */
const MODEL_SELECTION_SEP = "::";

/** 构建对话中使用的模型选择 ID */
export function buildModelSelectionId(
  providerId: string,
  modelName: string
): string {
  return `${providerId}${MODEL_SELECTION_SEP}${modelName}`;
}

/** 解析模型选择 ID */
export function parseModelSelectionId(
  selectionId: string
): { providerId: string; modelName: string } | null {
  const sep = selectionId.indexOf(MODEL_SELECTION_SEP);
  if (sep <= 0) return null;
  const providerId = selectionId.slice(0, sep);
  const modelName = selectionId.slice(sep + MODEL_SELECTION_SEP.length);
  if (!providerId || !modelName) return null;
  return { providerId, modelName };
}

/** 根据选择 ID 解析出 LangChain 所需的模型配置 */
export function resolveModelSelection(
  providers: AiModelProvider[],
  selectionId: string
): {
  apiStandard: ApiStandard;
  name: string;
  baseUrl: string;
  apiKey: string;
} | null {
  const parsed = parseModelSelectionId(selectionId);
  if (!parsed) return null;
  const provider = providers.find((p) => p.id === parsed.providerId);
  if (!provider) return null;
  if (!provider.modelNames.includes(parsed.modelName)) return null;
  return {
    apiStandard: provider.apiStandard,
    name: parsed.modelName,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  };
}

/** 列出所有可选择的模型（扁平化提供商下的多个模型名） */
export function listModelSelections(
  providers: AiModelProvider[]
): { id: string; label: string }[] {
  const items: { id: string; label: string }[] = [];
  for (const provider of providers) {
    for (const modelName of provider.modelNames) {
      const standard =
        provider.apiStandard === "anthropic" ? "Anthropic" : "OpenAI";
      items.push({
        id: buildModelSelectionId(provider.id, modelName),
        label: `${provider.providerName} / ${modelName} (${standard})`,
      });
    }
  }
  return items;
}

/** 返回第一个可用模型选择 ID，无则 null */
export function firstModelSelectionId(
  providers: AiModelProvider[]
): string | null {
  const first = providers[0];
  const modelName = first?.modelNames[0];
  if (!first || !modelName) return null;
  return buildModelSelectionId(first.id, modelName);
}

/** 查找全局重复的模型名称 */
export function findModelNameConflict(
  providers: AiModelProvider[],
  name: string,
  excludeProviderId?: string
): { providerName: string; modelName: string } | null {
  const lower = name.trim().toLowerCase();
  if (!lower) return null;
  for (const provider of providers) {
    if (provider.id === excludeProviderId) continue;
    for (const modelName of provider.modelNames) {
      if (modelName.toLowerCase() === lower) {
        return { providerName: provider.providerName, modelName };
      }
    }
  }
  return null;
}
