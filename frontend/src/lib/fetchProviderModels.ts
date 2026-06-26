import { normalizeBaseUrlForFetch } from "../stores/aiModelsStore";
import { buildBearerAuthorization } from "./fetchHeaders";

interface OpenAiModelsResponse {
  data?: Array<{
    id?: string;
    created?: number;
    owned_by?: string;
  }>;
}

/** 从 /models 接口拉取的单条模型信息 */
export interface ApiModelInfo {
  id: string;
  created?: number;
  ownedBy?: string;
}

/** 持久化在提供商配置中的接口模型元数据 */
export interface ApiModelMeta {
  created?: number;
  ownedBy?: string;
}

/** 从 OpenAI 兼容接口 GET {baseUrl}/models 拉取模型列表。 */
export async function fetchProviderModelList(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: true; models: ApiModelInfo[] } | { ok: false; error: string }> {
  const root = normalizeBaseUrlForFetch(baseUrl);
  if (!root) {
    return { ok: false, error: "invalid_base_url" };
  }

  const url = `${root}/models`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: buildBearerAuthorization(apiKey),
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }

    const payload = (await res.json()) as OpenAiModelsResponse;
    const raw: ApiModelInfo[] = [];
    const seen = new Set<string>();
    for (const item of payload.data ?? []) {
      const id = item.id?.trim();
      if (!id) continue;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const ownedBy = item.owned_by?.trim();
      raw.push({
        id,
        ...(item.created != null && Number.isFinite(item.created)
          ? { created: item.created }
          : {}),
        ...(ownedBy ? { ownedBy } : {}),
      });
    }

    if (raw.length === 0) {
      return { ok: false, error: "empty_list" };
    }

    raw.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));
    return { ok: true, models: raw };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 合并手动填写与远端拉取的模型名，手动项优先保留原始大小写。 */
export function mergeModelCatalog(manual: string[], fetched: ApiModelInfo[]): string[] {
  const fetchedIds = fetched.map((item) => item.id);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...manual, ...fetchedIds]) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged;
}

/** 根据合并后的模型名与接口返回，构建接口模型元数据映射。 */
export function buildApiModelMeta(
  modelNames: string[],
  manualModelNames: string[],
  fetched: ApiModelInfo[],
): Record<string, ApiModelMeta> {
  const manualKeys = new Set(manualModelNames.map((name) => name.toLowerCase()));
  const fetchedByKey = new Map(fetched.map((item) => [item.id.toLowerCase(), item]));
  const meta: Record<string, ApiModelMeta> = {};

  for (const name of modelNames) {
    if (manualKeys.has(name.toLowerCase())) continue;
    const item = fetchedByKey.get(name.toLowerCase());
    if (!item) continue;
    const entry: ApiModelMeta = {};
    if (item.created != null) entry.created = item.created;
    if (item.ownedBy) entry.ownedBy = item.ownedBy;
    if (entry.created != null || entry.ownedBy) {
      meta[name] = entry;
    }
  }
  return meta;
}

/** 将接口返回的 created 格式化为本地日期字符串。 */
export function formatApiModelCreated(created: number, locale?: string): string {
  const ms = created > 1e12 ? created : created * 1000;
  return new Date(ms).toLocaleDateString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** 子序列模糊匹配（支持跳过字符，如 gpt4 → gpt-4o）。 */
export function fuzzyMatchModelName(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const target = text.toLowerCase();
  if (target.includes(q)) return true;
  let qi = 0;
  for (let i = 0; i < target.length && qi < q.length; i++) {
    if (target[i] === q[qi]) qi++;
  }
  return qi === q.length;
}
