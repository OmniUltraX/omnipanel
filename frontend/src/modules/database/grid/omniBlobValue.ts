import type { ContentPreviewPayload } from "../../../lib/contentPreview";

export type OmniBlobKind = "image" | "audio" | "text" | "binary";

export type OmniBlobValue = {
  __omni: "blob";
  size: number;
  kind: OmniBlobKind;
  mime?: string;
  encoding?: "base64";
  data?: string;
};

function isOmniBlobKind(value: unknown): value is OmniBlobKind {
  return value === "image" || value === "audio" || value === "text" || value === "binary";
}

/** 解析查询结果中的结构化 BLOB（后端 `encode_blob_value`）。 */
export function parseOmniBlobValue(value: unknown): OmniBlobValue | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.__omni !== "blob") {
    return null;
  }
  const size = record.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    return null;
  }
  if (!isOmniBlobKind(record.kind)) {
    return null;
  }
  const mime = typeof record.mime === "string" ? record.mime : undefined;
  const encoding = record.encoding === "base64" ? "base64" : undefined;
  const data = typeof record.data === "string" ? record.data : undefined;
  return {
    __omni: "blob",
    size,
    kind: record.kind,
    mime,
    encoding,
    data: encoding === "base64" ? data : undefined,
  };
}

export function isOmniBlobValue(value: unknown): value is OmniBlobValue {
  return parseOmniBlobValue(value) != null;
}

function formatBlobSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function mimeShortLabel(mime: string | undefined, kind: OmniBlobKind): string {
  if (!mime) {
    return kind === "binary" ? "BIN" : kind.toUpperCase();
  }
  const subtype = mime.split("/")[1]?.split("+")[0]?.toUpperCase();
  if (subtype) return subtype;
  return mime.toUpperCase();
}

/** 网格单元格展示文案，如 `[BLOB · PNG · 12.3 KB]` */
export function formatOmniBlobDisplayText(blob: OmniBlobValue, placeholder = "BLOB"): string {
  const typeLabel = mimeShortLabel(blob.mime, blob.kind);
  return `[${placeholder} · ${typeLabel} · ${formatBlobSize(blob.size)}]`;
}

function decodeBase64Utf8(data: string): string {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

/** 将结构化 BLOB 转为 ContentPreviewView 可消费的内容。 */
export function resolveOmniBlobPreviewContent(blob: OmniBlobValue): ContentPreviewPayload {
  const hasData = blob.encoding === "base64" && typeof blob.data === "string" && blob.data.length > 0;

  if (blob.kind === "image" && hasData) {
    const mime = blob.mime ?? "application/octet-stream";
    return {
      kind: "image",
      url: `data:${mime};base64,${blob.data}`,
      alt: formatOmniBlobDisplayText(blob),
    };
  }

  if (blob.kind === "audio" && hasData) {
    const mime = blob.mime ?? "application/octet-stream";
    return {
      kind: "audio",
      url: `data:${mime};base64,${blob.data}`,
      mimeType: mime,
    };
  }

  if (blob.kind === "text" && hasData) {
    const text = decodeBase64Utf8(blob.data!);
    return { kind: "text", text: text || formatOmniBlobDisplayText(blob) };
  }

  if (blob.kind === "image" || blob.kind === "audio" || blob.kind === "text") {
    return {
      kind: "text",
      text: `${formatOmniBlobDisplayText(blob)}\n\n内容超过内联预览上限（2 MB），无法在此直接展示。`,
    };
  }

  return {
    kind: "text",
    text: `${formatOmniBlobDisplayText(blob)}\n\n二进制内容暂不支持预览。`,
  };
}
