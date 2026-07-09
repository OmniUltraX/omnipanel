export interface HttpPathParamPair {
  key: string;
  value: string;
  enabled: boolean;
}

const PATH_PARAM_NAME_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** 从路径模板中提取路径参数名（按出现顺序，去重）。 */
export function extractPathParamNames(path: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of path.matchAll(PATH_PARAM_NAME_RE)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** 地址栏变更时，同步路径参数列表（保留已有值）。 */
export function syncPathParamsFromUrl(url: string, existing: HttpPathParamPair[]): HttpPathParamPair[] {
  const names = extractPathParamNames(url);
  if (names.length === 0) {
    return [];
  }
  const byKey = new Map(existing.map((pair) => [pair.key, pair]));
  return names.map((name) => {
    const prev = byKey.get(name);
    return prev ?? { key: name, value: "", enabled: true };
  });
}

/** 将路径模板中的 `:name` 替换为用户填写的值。 */
export function applyPathParamsToPath(path: string, pathParams: HttpPathParamPair[]): string {
  let result = path;
  for (const pair of pathParams) {
    if (!pair.enabled || !pair.key) {
      continue;
    }
    const token = `:${pair.key}`;
    if (!result.includes(token)) {
      continue;
    }
    const segment = encodeURIComponent(pair.value);
    result = result.split(token).join(segment);
  }
  return result;
}

/** 替换后是否仍存在未填写的 `:param` 占位符。 */
export function hasUnresolvedPathParams(path: string, pathParams: HttpPathParamPair[]): boolean {
  const resolved = applyPathParamsToPath(path, pathParams);
  PATH_PARAM_NAME_RE.lastIndex = 0;
  return PATH_PARAM_NAME_RE.test(resolved);
}

function normalizePathParamPair(raw: unknown): HttpPathParamPair {
  if (typeof raw !== "object" || raw === null) {
    return { key: "", value: "", enabled: true };
  }
  const item = raw as Record<string, unknown>;
  return {
    key: typeof item.key === "string" ? item.key : "",
    value: typeof item.value === "string" ? item.value : "",
    enabled: typeof item.enabled === "boolean" ? item.enabled : true,
  };
}

export function parsePathParams(raw: string | null | undefined): HttpPathParamPair[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(normalizePathParamPair);
  } catch {
    return [];
  }
}

export function serializePathParams(pathParams: HttpPathParamPair[]): string {
  return JSON.stringify(
    pathParams.map((pair) => ({
      key: pair.key,
      value: pair.value,
      enabled: pair.enabled,
    })),
  );
}
