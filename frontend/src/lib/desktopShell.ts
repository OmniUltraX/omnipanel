import { isTauriRuntime } from "./isTauriRuntime";

/** 保留浏览器原生菜单（拼写检查等），其余区域一律走应用内菜单或快捷键。 */
function allowsBrowserContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      'input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], .allow-browser-context-menu',
    ) !== null
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, [contenteditable='true']") !== null;
}

/**
 * 在 Tauri 桌面环境中压制 WebView 的浏览器默认行为，使交互更接近原生应用。
 * 应用内自定义右键菜单（React onContextMenu）不受影响。
 */
export function initDesktopShell(): void {
  if (!isTauriRuntime()) return;

  document.addEventListener(
    "contextmenu",
    (event) => {
      if (allowsBrowserContextMenu(event.target)) return;
      event.preventDefault();
    },
    { capture: true },
  );

  document.addEventListener("dragstart", (event) => {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
  });

  document.addEventListener(
    "drop",
    (event) => {
      event.preventDefault();
    },
    { capture: true },
  );

  document.addEventListener(
    "dragover",
    (event) => {
      event.preventDefault();
    },
    { capture: true },
  );

  document.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey) event.preventDefault();
    },
    { passive: false, capture: true },
  );

  document.addEventListener(
    "gesturestart",
    (event) => {
      event.preventDefault();
    },
    { passive: false },
  );

  document.addEventListener(
    "keydown",
    (event) => {
      const key = event.key.toLowerCase();

      if (import.meta.env.PROD) {
        if (key === "f5" || (key === "r" && (event.ctrlKey || event.metaKey))) {
          event.preventDefault();
          return;
        }

        if ((key === "+" || key === "-" || key === "=") && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          return;
        }

        if (key === "f12") {
          event.preventDefault();
        }
      }
    },
    { capture: true },
  );

  document.addEventListener(
    "auxclick",
    (event) => {
      if (event.button !== 1) return;
      const el = event.target instanceof Element ? event.target : null;
      if (el?.closest("a[href]")) {
        event.preventDefault();
      }
    },
    { capture: true },
  );
}
