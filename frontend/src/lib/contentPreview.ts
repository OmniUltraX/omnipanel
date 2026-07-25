/** 预览区 URL / 格式检测（数据库单元格、文件文本等共用） */

/** 排除 true / localhost 以外的单词主机名被误判为网址。 */
function isPlausibleWebHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host === "localhost") return true;
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6（URL.hostname 可能带或不带括号外的形式）
  if (host.includes(":")) return true;
  // 必须含点，且各段合法（example.com / a.b.co）
  if (!host.includes(".")) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host);
}

export function normalizePreviewWebUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 2048) return null;

  const hasScheme = /^https?:\/\//i.test(trimmed);
  // 无协议时必须像域名（含点），避免 `true` → `https://true`
  if (!hasScheme && !trimmed.includes(".")) return null;

  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isPlausibleWebHostname(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function isPreviewWebUrl(text: string): boolean {
  return normalizePreviewWebUrl(text) !== null;
}

/** 尝试将文本解析为 JSON 对象/数组；无效或非对象类型返回 null。 */
export function parsePreviewJsonText(text: string): object | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const DATA_AUDIO_RE = /^data:audio\/[a-z0-9.+-]+;base64,/i;
const HTTP_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)(\?|#|$)/i;
const RAW_BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

function mimeFromImageMagic(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
}

function decodeBase64ToBytes(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** 从纯文本嗅探图片 / 音频预览（data URL、图片链接、裸 base64）。 */
export function resolvePreviewMediaFromText(text: string): ContentPreviewPayload | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (DATA_IMAGE_RE.test(trimmed)) {
    return { kind: "image", url: trimmed };
  }
  if (DATA_AUDIO_RE.test(trimmed)) {
    const mimeMatch = /^data:(audio\/[a-z0-9.+-]+);base64,/i.exec(trimmed);
    return {
      kind: "audio",
      url: trimmed,
      mimeType: mimeMatch?.[1] ?? "audio/mpeg",
    };
  }

  const webUrl = normalizePreviewWebUrl(trimmed);
  if (webUrl && HTTP_IMAGE_EXT_RE.test(webUrl)) {
    return { kind: "image", url: webUrl, alt: webUrl };
  }

  if (trimmed.length >= 64 && trimmed.length <= 8_000_000 && RAW_BASE64_RE.test(trimmed) && !trimmed.includes(" ")) {
    const bytes = decodeBase64ToBytes(trimmed);
    if (bytes) {
      const mime = mimeFromImageMagic(bytes);
      if (mime) {
        return { kind: "image", url: `data:${mime};base64,${trimmed}` };
      }
    }
  }

  // Redis 等转义的二进制：\x89\x50\x4e\x47...
  if (trimmed.startsWith("\\x") && !trimmed.includes("…")) {
    const hex = trimmed.replace(/\\x/gi, "");
    if (/^[0-9a-f]+$/i.test(hex) && hex.length >= 16 && hex.length % 2 === 0 && hex.length <= 8_000_000) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      const mime = mimeFromImageMagic(bytes);
      if (mime) {
        let binary = "";
        for (let i = 0; i < bytes.length; i += 1) {
          binary += String.fromCharCode(bytes[i]!);
        }
        return { kind: "image", url: `data:${mime};base64,${btoa(binary)}` };
      }
    }
  }

  return null;
}

/** 粗判 Markdown（多信号命中，降低误报）。 */
export function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) {
    return false;
  }
  const patterns = [
    /^#{1,6}\s+\S/m,
    /^```[\w-]*$/m,
    /^\*\s+\S/m,
    /^-\s+\S/m,
    /^\d+\.\s+\S/m,
    /\[[^\]]+\]\([^)]+\)/,
    /^>\s+\S/m,
    /\*\*[^*\n]+\*\*/,
    /^---$/m,
  ];
  let hits = 0;
  for (const pattern of patterns) {
    if (pattern.test(trimmed)) {
      hits += 1;
    }
  }
  if (hits >= 2) {
    return true;
  }
  return /^#{1,6}\s+\S/m.test(trimmed) && trimmed.includes("\n");
}

/** 粗判 HTML 文档/片段。 */
export function looksLikeHtmlDocument(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12) {
    return false;
  }
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return true;
  }
  // 常见富文本片段：成对标签 + 足够长度
  if (!/^<[a-z!]/i.test(trimmed)) {
    return false;
  }
  return (
    /<\/(div|p|span|table|ul|ol|li|section|article|body|html|h[1-6])\s*>/i.test(trimmed) &&
    trimmed.length >= 40
  );
}

export type PreviewWebTarget =
  | { type: "url"; url: string }
  | { type: "html"; html: string };

/** HTTP(S) 链接或 HTML 文档 → Web 预览目标。 */
export function resolvePreviewWebTarget(text: string): PreviewWebTarget | null {
  const url = normalizePreviewWebUrl(text);
  if (url) {
    return { type: "url", url };
  }
  if (looksLikeHtmlDocument(text)) {
    return { type: "html", html: text.trim() };
  }
  return null;
}

/** 根据内容推荐默认文本预览模式。 */
export function resolvePreferredPreviewTextMode(
  content: ContentPreviewPayload,
): ContentPreviewTextMode {
  if (content.kind === "json") {
    return "json";
  }
  if (content.kind !== "text") {
    return "plain";
  }
  if (parsePreviewJsonText(content.text)) {
    return "json";
  }
  if (resolvePreviewWebTarget(content.text)) {
    return "web";
  }
  if (looksLikeMarkdown(content.text)) {
    return "markdown";
  }
  return "plain";
}

export type ContentPreviewPayload =
  | { kind: "json"; value: object }
  | { kind: "text"; text: string }
  | { kind: "image"; url: string; alt?: string }
  | { kind: "audio"; url: string; mimeType?: string }
  | { kind: "video"; url: string; mimeType?: string; poster?: string };

export type ContentPreviewStatus = "loading" | "error" | "empty" | "ready";

export type ContentPreviewTextMode = "plain" | "code" | "markdown" | "web" | "json";
