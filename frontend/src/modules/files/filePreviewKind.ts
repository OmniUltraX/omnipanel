import { isGridImageFile } from "./utils";

export type FilePreviewKind = "json" | "text" | "image" | "unsupported";

const JSON_EXTENSIONS = new Set(["json", "jsonc", "json5", "geojson"]);

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "json", "jsonc", "json5", "geojson", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "js", "ts", "tsx", "jsx", "css", "html", "rs", "go", "py", "sh", "sql", "log",
]);

export function isJsonPreviewFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return JSON_EXTENSIONS.has(ext);
}

export function isTextPreviewFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

export function resolveFilePreviewKind(name: string): FilePreviewKind {
  if (isGridImageFile(name)) return "image";
  if (isJsonPreviewFile(name)) return "json";
  if (isTextPreviewFile(name)) return "text";
  return "unsupported";
}

/** 解析 JSON 文件文本；对象/数组返回结构化值，解析失败或非对象返回 null。 */
export function parsePreviewJsonText(text: string): object | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as object;
    }
  } catch {
    // 非合法 JSON，由调用方回退为文本预览
  }
  return null;
}

export function decodePreviewBytes(bytes: number[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return "";
  }
}
