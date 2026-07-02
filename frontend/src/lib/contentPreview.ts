/** 预览区 URL 检测（数据库单元格、文件文本等共用） */

export function normalizePreviewWebUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 2048) return null;

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function isPreviewWebUrl(text: string): boolean {
  return normalizePreviewWebUrl(text) !== null;
}

export type ContentPreviewPayload =
  | { kind: "json"; value: object; /** @deprecated 已统一使用 VirtualJsonView */ virtual?: boolean }
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; alt?: string };

export type ContentPreviewStatus = "loading" | "error" | "empty" | "ready";

export type ContentPreviewTextMode = "plain" | "code" | "markdown" | "web";
