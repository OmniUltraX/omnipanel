import { isTauriRuntime } from "./isTauriRuntime";
import { logDockerDrag } from "@/modules/docker/dockerDragDebug";
import { DOCKER_CONTAINER_DRAG_MIME } from "@/stores/dockerServiceGroupStore";

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

/** 允许应用内显式声明 draggable 的节点使用 HTML5 拖放（如 Docker 容器 → 服务组）。 */
function allowsNativeDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('[draggable="true"]') !== null;
}

function isDockerContainerDragEvent(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return types.includes(DOCKER_CONTAINER_DRAG_MIME) || types.includes("text/plain");
}

function isDockerServiceGroupDropTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest('[data-sidebar-tree-node-type="service-group"]') !== null ||
    target.closest(".docker-service-group-category") !== null ||
    target.closest(".docker-service-group-drop-zone") !== null
  );
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
    if (isEditableTarget(event.target)) {
      logDockerDrag("shell:dragstart-skipped", { reason: "editable-target" });
      return;
    }
    if (allowsNativeDragTarget(event.target)) {
      logDockerDrag("shell:dragstart-allowed", {
        targetTag: (event.target as Element | null)?.tagName ?? null,
        draggableHost: (event.target as Element | null)
          ?.closest('[draggable="true"]')
          ?.className?.toString(),
      });
      return;
    }
    logDockerDrag("shell:dragstart-blocked", {
      targetTag: (event.target as Element | null)?.tagName ?? null,
    });
    event.preventDefault();
  });

  document.addEventListener(
    "drop",
    (event) => {
      logDockerDrag("shell:drop-capture", {
        targetTag: (event.target as Element | null)?.tagName ?? null,
        defaultPrevented: event.defaultPrevented,
      });
      event.preventDefault();
    },
    { capture: true },
  );

  document.addEventListener(
    "dragover",
    (event) => {
      event.preventDefault();
      if (isDockerContainerDragEvent(event) && isDockerServiceGroupDropTarget(event.target)) {
        event.dataTransfer!.dropEffect = "move";
      }
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
