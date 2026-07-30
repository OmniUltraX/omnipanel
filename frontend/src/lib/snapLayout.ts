import { isTauriRuntime } from "./isTauriRuntime";

/** 与 Rust `tauri_plugin_snap_layout::init().button_id(...)` 保持一致 */
export const OMNIPANEL_SNAP_MAXIMIZE_ID = "omnipanel-snap-maximize";

declare global {
  interface Window {
    __SNAP_LAYOUT_ATTACH__?: (id?: string) => void;
    __SNAP_LAYOUT_IS_ATTACHED__?: () => boolean;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** 等待插件注入脚本挂上 attach hook（模块窗冷启动常见竞态） */
async function waitForSnapAttachHook(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    if (typeof window.__SNAP_LAYOUT_ATTACH__ === "function") return true;
    await sleep(40);
  }
  return typeof window.__SNAP_LAYOUT_ATTACH__ === "function";
}

/**
 * 将 Snap Layout 原生 overlay 挂到最大化按钮。
 * 会重试等待插件 hook，并在布局稳定后再 attach 一次。
 */
export async function attachSnapMaximizeButton(
  button: HTMLElement | null | undefined,
  options?: { signal?: AbortSignal; buttonId?: string },
): Promise<void> {
  if (!isTauriRuntime() || !button) return;
  const buttonId = options?.buttonId ?? OMNIPANEL_SNAP_MAXIMIZE_ID;
  const signal = options?.signal;

  button.id = buttonId;

  const ready = await waitForSnapAttachHook(5000, signal);
  if (!ready || signal?.aborted) {
    if (!ready) {
      console.warn("[snapLayout] plugin attach hook not ready");
    }
    return;
  }

  try {
    const { attach } = await import("tauri-plugin-snap-layout");
    // 先 attach：即使按钮稍后才进 DOM，插件会把 isAttached=true，MutationObserver 会补绑
    attach(buttonId);
    for (const delay of [80, 240, 600]) {
      await sleep(delay);
      if (signal?.aborted) return;
      const el = document.getElementById(buttonId) ?? button;
      el.id = buttonId;
      attach(buttonId);
    }
  } catch (e) {
    console.warn("[snapLayout] attach failed", e);
  }
}
