import { normalizeBaseUrlForFetch } from "../stores/aiModelsStore";

interface OpenAiModelsResponse {
  data?: Array<{ id?: string }>;
}

/** 从 OpenAI 兼容接口 GET {baseUrl}/models 拉取模型 ID 列表。 */
export async function fetchProviderModelList(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const root = normalizeBaseUrlForFetch(baseUrl);
  if (!root) {
    return { ok: false, error: "invalid_base_url" };
  }

  const url = `${root}/models`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }

    const payload = (await res.json()) as OpenAiModelsResponse;
    const raw = (payload.data ?? [])
      .map((item) => item.id?.trim())
      .filter((id): id is string => Boolean(id));

    if (raw.length === 0) {
      return { ok: false, error: "empty_list" };
    }

    const seen = new Set<string>();
    const models: string[] = [];
    for (const name of raw) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(name);
    }
    models.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 合并手动填写与远端拉取的模型名，手动项优先保留原始大小写。 */
export function mergeModelCatalog(manual: string[], fetched: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...manual, ...fetched]) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged;
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
