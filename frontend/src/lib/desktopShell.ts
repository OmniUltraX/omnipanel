import { isTauriRuntime } from "./isTauriRuntime";

/** 显式声明后仍允许浏览器原生右键菜单（极少数场景）。 */
function allowsBrowserContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(".allow-browser-context-menu") !== null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("input, textarea, [contenteditable='true']") !== null;
}

/** 允许应用内显式声明 draggable 的节点使用 HTML5 拖放。 */
function allowsNativeDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('[draggable="true"]') !== null;
}

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable=""], [contenteditable="true"]';

/** 关闭拼写检查、自动纠正与浏览器自动填充相关属性。 */
function hardenEditableElement(el: Element): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (!el.hasAttribute("autocomplete")) {
      el.setAttribute("autocomplete", "off");
    }
    el.setAttribute("spellcheck", "false");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
    if (!el.hasAttribute("data-1p-ignore")) {
      el.setAttribute("data-1p-ignore", "true");
    }
    if (!el.hasAttribute("data-lpignore")) {
      el.setAttribute("data-lpignore", "true");
    }
    if (!el.hasAttribute("data-form-type")) {
      el.setAttribute("data-form-type", "other");
    }
    return;
  }

  if (el instanceof HTMLElement && el.isContentEditable) {
    el.setAttribute("spellcheck", "false");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
  }
}

function hardenEditableTree(root: ParentNode = document): void {
  root.querySelectorAll?.(EDITABLE_SELECTOR).forEach(hardenEditableElement);
  if (root instanceof Element && root.matches?.(EDITABLE_SELECTOR)) {
    hardenEditableElement(root);
  }
}

function watchEditableElements(): void {
  hardenEditableTree(document);

  // rAF 节流：全屏切换等批量 DOM 操作会产生大量 mutation records，
  // 每批都跑 querySelectorAll 会阻塞主线程。合并到一帧处理。
  let raf = 0;
  const pendingNodes: Set<Node> = new Set();
  const pendingAttributes: Set<Element> = new Set();

  const flush = () => {
    raf = 0;
    if (pendingAttributes.size > 0) {
      for (const el of pendingAttributes) {
        if (el.matches(EDITABLE_SELECTOR)) hardenEditableElement(el);
      }
      pendingAttributes.clear();
    }
    if (pendingNodes.size > 0) {
      for (const node of pendingNodes) {
        if (node instanceof Element || node instanceof DocumentFragment) {
          hardenEditableTree(node);
        }
      }
      pendingNodes.clear();
    }
  };

  const scheduleFlush = () => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(flush);
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.target instanceof Element) {
        pendingAttributes.add(mutation.target);
      } else {
        for (const node of mutation.addedNodes) {
          pendingNodes.add(node);
        }
      }
    }
    scheduleFlush();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["contenteditable"],
  });
}

/**
 * 在 Tauri 桌面环境中压制 WebView 的浏览器默认行为，使交互更接近原生应用。
 * 应用内自定义右键菜单（React onContextMenu）不受影响。
 */
export function initDesktopShell(): void {
  if (!isTauriRuntime()) return;

  document.documentElement.setAttribute("spellcheck", "false");
  document.documentElement.setAttribute("autocomplete", "off");
  watchEditableElements();

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
    if (allowsNativeDragTarget(event.target)) return;
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
