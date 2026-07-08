import { invoke } from "@tauri-apps/api/core";

const MAX_ERRORS = 8;
const errors: string[] = [];
let panel: HTMLDivElement | null = null;

function formatError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") return reason;
  if (reason == null || typeof reason === "number" || typeof reason === "boolean") {
    return String(reason);
  }
  try {
    return JSON.stringify(reason);
  } catch {
    try {
      return String(reason);
    } catch {
      return "[unserializable value]";
    }
  }
}

/** react-resizable-panels 在叠层/全屏切换时偶发 stacking-order 断言失败（非业务错误） */
function isBenignResizablePanelsStackingError(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "";
  return message.includes(
    "Stacking order can only be calculated for elements with a common ancestor",
  );
}

/** Tauri onResized 使用 async 回调时，reject 会以 event 对象冒泡为 unhandledrejection */
function isBenignTauriResizeRejection(reason: unknown): boolean {
  if (reason == null || typeof reason !== "object") return false;
  return (reason as { event?: string }).event === "tauri://resize";
}

/** 浏览器在 ResizeObserver 同帧反馈布局时的已知无害告警，非应用逻辑错误。 */
function isBenignResizeObserverNoise(message: string): boolean {
  return (
    message.includes("ResizeObserver loop completed with undelivered notifications") ||
    message.includes("ResizeObserver loop limit exceeded")
  );
}

function renderPanel() {
  if (errors.length === 0) {
    panel?.remove();
    panel = null;
    return;
  }

  if (!panel) {
    panel = document.createElement("div");
    panel.id = "omnipanel-prod-errors";
    Object.assign(panel.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "99998",
      maxWidth: "min(520px, calc(100vw - 24px))",
      maxHeight: "40vh",
      overflow: "auto",
      background: "#2a1515",
      color: "#ffb4b4",
      border: "1px solid #ff6b6b55",
      borderRadius: "8px",
      padding: "10px 12px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "11px",
      lineHeight: "1.45",
      boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    } as CSSStyleDeclaration);

    const toolbar = document.createElement("div");
    Object.assign(toolbar.style, {
      display: "flex",
      gap: "8px",
      marginBottom: "8px",
      alignItems: "center",
      flexWrap: "wrap",
    } as CSSStyleDeclaration);

    const title = document.createElement("span");
    title.textContent = "前端错误（Release 无 DevTools 时可见）";
    Object.assign(title.style, { color: "#fff", fontWeight: "600" } as CSSStyleDeclaration);

    const devtoolsBtn = document.createElement("button");
    devtoolsBtn.type = "button";
    devtoolsBtn.textContent = "DevTools (Ctrl+Shift+I)";
    Object.assign(devtoolsBtn.style, {
      marginLeft: "auto",
      background: "#ff6b6b22",
      color: "#fff",
      border: "1px solid #ff6b6b66",
      borderRadius: "4px",
      padding: "2px 8px",
      cursor: "pointer",
      fontSize: "11px",
    } as CSSStyleDeclaration);
    devtoolsBtn.onclick = () => {
      void openDevtools();
    };

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "复制";
    Object.assign(copyBtn.style, {
      background: "#ff6b6b22",
      color: "#fff",
      border: "1px solid #ff6b6b66",
      borderRadius: "4px",
      padding: "2px 8px",
      cursor: "pointer",
      fontSize: "11px",
    } as CSSStyleDeclaration);
    copyBtn.onclick = () => {
      void copyErrorsToClipboard(copyBtn);
    };

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "清除";
    Object.assign(clearBtn.style, {
      background: "transparent",
      color: "#ccc",
      border: "1px solid #666",
      borderRadius: "4px",
      padding: "2px 8px",
      cursor: "pointer",
      fontSize: "11px",
    } as CSSStyleDeclaration);
    clearBtn.onclick = () => {
      errors.length = 0;
      renderPanel();
    };

    toolbar.append(title, devtoolsBtn, copyBtn, clearBtn);
    panel.append(toolbar);

    const body = document.createElement("div");
    body.dataset.role = "body";
    panel.append(body);
    document.body.append(panel);
  }

  const body = panel.querySelector<HTMLDivElement>('[data-role="body"]');
  if (body) {
    body.textContent = errors.join("\n\n— — —\n\n");
  }
}

async function copyErrorsToClipboard(button: HTMLButtonElement): Promise<void> {
  const text = errors.join("\n\n— — —\n\n");
  if (!text) return;

  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // WebView 下 navigator.clipboard 可能不可用，降级到 execCommand。
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      ok = document.execCommand("copy");
      textarea.remove();
    } catch {
      ok = false;
    }
  }

  const original = button.textContent;
  button.textContent = ok ? "已复制" : "复制失败";
  window.setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

function pushError(message: string) {
  errors.unshift(message);
  if (errors.length > MAX_ERRORS) {
    errors.length = MAX_ERRORS;
  }
  renderPanel();
}

export async function openDevtools(): Promise<void> {
  try {
    await invoke("debug_open_devtools");
  } catch (err) {
    pushError(formatError(err));
  }
}

/** Release 包无 DevTools 时：捕获前端错误 + 快捷键打开 Inspector。 */
export function initProductionDiagnostics(): void {
  window.addEventListener("error", (event) => {
    if (isBenignResizeObserverNoise(event.message)) return;
    if (isBenignResizablePanelsStackingError(event.error)) {
      event.preventDefault();
      return;
    }
    const detail = event.error ? formatError(event.error) : event.message;
    pushError(`[error] ${detail}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (isBenignTauriResizeRejection(event.reason)) {
      event.preventDefault();
      return;
    }
    if (isBenignResizablePanelsStackingError(event.reason)) {
      event.preventDefault();
      return;
    }
    pushError(`[unhandledrejection] ${formatError(event.reason)}`);
  });

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    const message = args.map((a) => formatError(a)).join(" ");
    if (isBenignResizeObserverNoise(message)) return;
    pushError(`[console.error] ${message}`);
  };

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && (event.key === "I" || event.key === "i")) {
        event.preventDefault();
        void openDevtools();
      }
    },
    true,
  );
}
