export interface HttpCurlCommandInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: string | null;
  authType?: string | null;
  authValue?: string | null;
}

function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appendAuthHeaders(
  headers: Record<string, string>,
  authType?: string | null,
  authValue?: string | null,
): Record<string, string> {
  const trimmed = authValue?.trim();
  if (!authType || !trimmed) {
    return headers;
  }
  const next = { ...headers };
  switch (authType) {
    case "Bearer":
      next.Authorization = `Bearer ${trimmed}`;
      break;
    case "Basic":
      next.Authorization = `Basic ${trimmed}`;
      break;
    case "API Key":
      next["X-API-Key"] = trimmed;
      break;
    default:
      next.Authorization = trimmed;
      break;
  }
  return next;
}

/** 根据实际发送的请求参数生成 curl 命令（单行可折行）。 */
export function buildHttpCurlCommand(input: HttpCurlCommandInput): string {
  const method = input.method.toUpperCase();
  let url = input.url.trim();
  if (input.queryParams && Object.keys(input.queryParams).length > 0) {
    const qs = new URLSearchParams(
      Object.entries(input.queryParams).map(([key, value]) => [key, String(value)]),
    ).toString();
    if (qs) {
      url += url.includes("?") ? `&${qs}` : `?${qs}`;
    }
  }

  const headers = appendAuthHeaders(input.headers, input.authType, input.authValue);
  const parts: string[] = [`curl -X ${method} ${shellEscapeSingleQuoted(url)}`];

  for (const [key, value] of Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`  -H ${shellEscapeSingleQuoted(`${key}: ${value}`)}`);
  }

  const body = input.body?.trim();
  if (body && method !== "GET" && method !== "HEAD") {
    parts.push(`  -d ${shellEscapeSingleQuoted(body)}`);
  }

  return parts.join(" \\\n");
}
