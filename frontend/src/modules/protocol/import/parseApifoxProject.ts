import type {
  ProtocolImportDocument,
  ProtocolImportKv,
  ProtocolImportNode,
  ProtocolImportRequest,
} from "./protocolImportTypes";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** 是否为 Apifox 项目导出 JSON */
export function isApifoxProject(data: unknown): boolean {
  const root = asRecord(data);
  if (!root) return false;
  if (typeof root.apifoxProject === "string") return true;
  const schema = asRecord(root.$schema);
  if (schema && schema.app === "apifox") return true;
  return Array.isArray(root.apiCollection);
}

function paramValue(raw: JsonRecord): string {
  if (typeof raw.value === "string" && raw.value.trim()) return raw.value;
  if (typeof raw.example === "string" && raw.example.trim()) return raw.example;
  const schema = asRecord(raw.schema);
  if (schema) {
    if (typeof schema.default === "string" || typeof schema.default === "number") {
      return String(schema.default);
    }
    if (Array.isArray(schema.examples) && schema.examples.length > 0) {
      const first = schema.examples[0];
      if (typeof first === "string" || typeof first === "number" || typeof first === "boolean") {
        return String(first);
      }
    }
  }
  return "";
}

function mapParamList(list: unknown): ProtocolImportKv[] {
  const result: ProtocolImportKv[] = [];
  for (const item of asArray(list)) {
    const row = asRecord(item);
    if (!row) continue;
    const key = asString(row.name).trim();
    if (!key) continue;
    const enabled = row.enable === false || row.enabled === false ? false : true;
    result.push({
      key,
      value: paramValue(row),
      enabled,
    });
  }
  return result;
}

/** Apifox `{id}` → OmniPanel `:id` */
export function convertApifoxPathToOmni(path: string): string {
  return path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1");
}

function extractBody(api: JsonRecord): string {
  const requestBody = asRecord(api.requestBody);
  if (!requestBody) return "";
  const type = asString(requestBody.type, "none").toLowerCase();
  if (!type || type === "none") return "";

  // 优先调试用例里的示例数据
  for (const caseItem of asArray(api.cases)) {
    const c = asRecord(caseItem);
    const caseBody = asRecord(c?.requestBody);
    const data = caseBody?.data;
    if (typeof data === "string" && data.trim()) {
      return data;
    }
  }

  if (typeof requestBody.example === "string" && requestBody.example.trim()) {
    return requestBody.example;
  }

  if (type.includes("json")) {
    return "";
  }

  // form / multipart：拼 key=value
  const params = mapParamList(requestBody.parameters);
  if (params.length === 0) return "";
  if (type.includes("x-www-form-urlencoded") || type === "form") {
    return params
      .filter((p) => p.enabled && p.key)
      .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
      .join("&");
  }
  return "";
}

function mapHeaders(api: JsonRecord, body: string, bodyType: string): ProtocolImportKv[] {
  const parameters = asRecord(api.parameters);
  const headers = mapParamList(parameters?.header);
  const hasContentType = headers.some((h) => h.key.toLowerCase() === "content-type");
  if (!hasContentType && body && bodyType.includes("json")) {
    headers.unshift({
      key: "Content-Type",
      value: "application/json",
      enabled: true,
    });
  }
  return headers;
}

function mapApi(name: string, api: JsonRecord): ProtocolImportRequest {
  const method = asString(api.method, "GET").toUpperCase() || "GET";
  const rawPath = asString(api.path, "/");
  const url = convertApifoxPathToOmni(rawPath || "/");
  const parameters = asRecord(api.parameters);
  const requestBody = asRecord(api.requestBody);
  const bodyType = asString(requestBody?.type, "none");
  const body = extractBody(api);
  const pathParams = mapParamList(parameters?.path);
  // 路径里的 :name 若未在 parameters.path 声明，补空值行
  const pathNames = [...url.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const byKey = new Map(pathParams.map((p) => [p.key, p]));
  const mergedPathParams = pathNames.map(
    (key) => byKey.get(key) ?? { key, value: "", enabled: true },
  );

  return {
    name: name.trim() || method + " " + url,
    method,
    url,
    headers: mapHeaders(api, body, bodyType),
    queryParams: mapParamList(parameters?.query),
    pathParams: mergedPathParams,
    body,
    authType: "",
    authValue: "",
  };
}

function walkItems(items: unknown): ProtocolImportNode[] {
  const nodes: ProtocolImportNode[] = [];
  for (const item of asArray(items)) {
    const row = asRecord(item);
    if (!row) continue;
    const api = asRecord(row.api);
    if (api && (asString(api.type, "http") === "http" || asString(api.method))) {
      nodes.push({
        kind: "request",
        request: mapApi(asString(row.name, "Untitled"), api),
      });
      continue;
    }
    if (Array.isArray(row.items)) {
      const children = walkItems(row.items);
      if (children.length === 0) continue;
      nodes.push({
        kind: "folder",
        folder: {
          name: asString(row.name, "Folder").trim() || "Folder",
          children,
        },
      });
    }
  }
  return nodes;
}

function collectionChildren(apiCollection: unknown): ProtocolImportNode[] {
  const roots: ProtocolImportNode[] = [];
  for (const col of asArray(apiCollection)) {
    const row = asRecord(col);
    if (!row) continue;
    const name = asString(row.name).trim();
    const children = walkItems(row.items);
    if (children.length === 0) continue;
    // Apifox 常有「根目录」外壳，直接展开其子项
    if (!name || name === "根目录" || name.toLowerCase() === "root") {
      roots.push(...children);
      continue;
    }
    roots.push({
      kind: "folder",
      folder: { name, children },
    });
  }
  return roots;
}

/** 将 Apifox 项目 JSON 转为协议导入文档 */
export function parseApifoxProject(data: unknown): ProtocolImportDocument {
  if (!isApifoxProject(data)) {
    throw new Error("NOT_APIFOX");
  }
  const root = asRecord(data)!;
  const info = asRecord(root.info);
  const name =
    asString(info?.name).trim() ||
    asString(root.name).trim() ||
    "Apifox Import";
  const children = collectionChildren(root.apiCollection);
  if (children.length === 0) {
    throw new Error("EMPTY");
  }
  return {
    format: "apifox",
    name,
    roots: [
      {
        kind: "folder",
        folder: { name, children },
      },
    ],
  };
}
