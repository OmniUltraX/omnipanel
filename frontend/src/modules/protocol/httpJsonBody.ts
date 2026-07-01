/** 树形 JSON 预览（JsonView）体积上限。 */
export const MAX_HTTP_JSON_TREE_BYTES = 512 * 1024;

/** 允许同步格式化的 JSON 体积上限（用户主动触发）。 */
export const MAX_HTTP_JSON_FORMAT_BYTES = 4 * 1024 * 1024;

/** 纯文本响应在 pre 中直接展示的上限，超出则截断。 */
export const MAX_HTTP_PLAIN_BODY_BYTES = 256 * 1024;

/** @deprecated 使用 MAX_HTTP_JSON_TREE_BYTES */
export const MAX_HTTP_JSON_PREVIEW_BYTES = MAX_HTTP_JSON_TREE_BYTES;

export type HttpResponseBodyPreview =
  | { kind: "json-tree"; value: object }
  /** 512KB–4MB：异步解析后使用虚拟树预览 */
  | { kind: "json-large"; body: string; sizeBytes: number }
  | { kind: "json-source"; body: string; sizeBytes: number }
  | { kind: "text"; text: string }
  | { kind: "text-truncated"; preview: string; totalBytes: number };

export function formatHttpBodySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 保存前格式化 JSON 请求体；非法 JSON 或空内容保持原样。 */
export function formatHttpJsonBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > MAX_HTTP_JSON_FORMAT_BYTES) return body;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return body;
  }
}

export function tryFormatHttpJsonBody(
  body: string,
): { ok: true; text: string } | { ok: false; reason: "too-large" | "invalid" } {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, reason: "invalid" };
  if (trimmed.length > MAX_HTTP_JSON_FORMAT_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(trimmed), null, 2) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export function isHttpJsonContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes("json") || lower.includes("+json");
}

function looksLikeJsonBody(body: string): boolean {
  const trimmed = body.trim();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("\"") ||
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null" ||
    /^-?\d/.test(trimmed)
  );
}

/** 解析 HTTP 响应体预览策略：小 JSON 树形，大 JSON 源码，超大纯文本截断。 */
export function resolveHttpResponseBodyPreview(
  body: string,
  contentType: string,
): HttpResponseBodyPreview {
  const byteLength = new TextEncoder().encode(body).length;
  const tryJson = isHttpJsonContentType(contentType) || looksLikeJsonBody(body);
  const trimmed = body.trim();

  if (tryJson && trimmed.length > 0) {
    if (byteLength > MAX_HTTP_JSON_FORMAT_BYTES) {
      return { kind: "json-source", body, sizeBytes: byteLength };
    }
    if (byteLength > MAX_HTTP_JSON_TREE_BYTES) {
      return { kind: "json-large", body, sizeBytes: byteLength };
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        return { kind: "json-tree", value: parsed as object };
      }
    } catch {
      // 非合法 JSON，按文本展示
    }
  }

  if (byteLength > MAX_HTTP_PLAIN_BODY_BYTES) {
    const preview = body.slice(0, MAX_HTTP_PLAIN_BODY_BYTES);
    return { kind: "text-truncated", preview, totalBytes: byteLength };
  }

  return { kind: "text", text: body };
}

/** @deprecated 使用 resolveHttpResponseBodyPreview */
export function resolveHttpResponseBodyContent(body: string, contentType: string) {
  const preview = resolveHttpResponseBodyPreview(body, contentType);
  if (preview.kind === "json-tree") {
    return { kind: "json" as const, value: preview.value };
  }
  if (preview.kind === "json-large") {
    return { kind: "text" as const, text: preview.body };
  }
  if (preview.kind === "json-source") {
    return { kind: "text" as const, text: preview.body };
  }
  if (preview.kind === "text-truncated") {
    return { kind: "text" as const, text: preview.preview };
  }
  return { kind: "text" as const, text: preview.text };
}
