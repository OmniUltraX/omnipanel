/**
 * 快捷启动窗剪贴板读取：走 Tauri clipboard-manager 插件（无焦点唤起时 Web API 不可靠）。
 * 失败静默降级为空字符串，不阻塞启动窗渲染。
 */

import { isTauriRuntime } from "../isTauriRuntime";

/** 检测用文本上限，超长只取首段 */
export const CLIPBOARD_DETECT_MAX_CHARS = 20_000;

export interface ClipboardReadResult {
  text: string;
  truncated: boolean;
  /** 疑似密钥 / PEM：UI 只显示类型标签，不展示原文 */
  sensitive: boolean;
}

function looksSensitive(text: string): boolean {
  const t = text.trim();
  if (/-----BEGIN\s+(RSA\s+)?(PRIVATE\s+KEY|CERTIFICATE|OPENSSH\s+PRIVATE\s+KEY)-----/i.test(t)) {
    return true;
  }
  // 高熵短串（疑似 token / 密钥）：长度 24~128、几乎无空格、字符集较杂
  if (
    t.length >= 24 &&
    t.length <= 128 &&
    !/\s/.test(t) &&
    /[A-Za-z]/.test(t) &&
    /[0-9]/.test(t) &&
    /[+/=_-]/.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * 读取系统剪贴板文本。非 Tauri / 无权限 / 空剪贴板 → 返回空。
 */
export async function readClipboardText(): Promise<ClipboardReadResult> {
  const empty: ClipboardReadResult = { text: "", truncated: false, sensitive: false };
  if (!isTauriRuntime()) {
    try {
      const raw = (await navigator.clipboard.readText()).trim();
      if (!raw) return empty;
      const truncated = raw.length > CLIPBOARD_DETECT_MAX_CHARS;
      const text = truncated ? raw.slice(0, CLIPBOARD_DETECT_MAX_CHARS) : raw;
      return { text, truncated, sensitive: looksSensitive(text) };
    } catch {
      return empty;
    }
  }

  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    const raw = String((await readText()) ?? "").trim();
    if (!raw) return empty;
    const truncated = raw.length > CLIPBOARD_DETECT_MAX_CHARS;
    const text = truncated ? raw.slice(0, CLIPBOARD_DETECT_MAX_CHARS) : raw;
    return { text, truncated, sensitive: looksSensitive(text) };
  } catch (e) {
    console.warn("[quickLaunch] clipboard read failed", e);
    return empty;
  }
}
