import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "../../i18n";
import { useTauriWindowMaximized } from "../../hooks/useTauriWindowMaximized";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { MODULE_WINDOW_PREFIX } from "../../lib/moduleWindow";
import {
  attachSnapMaximizeButton,
  OMNIPANEL_SNAP_MAXIMIZE_ID,
} from "../../lib/snapLayout";

export { OMNIPANEL_SNAP_MAXIMIZE_ID };

/** 主窗 + 模块独立窗（`module-*`）可挂 Snap Layout；其它子窗/登录窗不挂 */
function isSnapLayoutEligibleWindow(): boolean {
  if (!isTauriRuntime()) return false;
  try {
    const label = getCurrentWindow().label;
    return label === "main" || label.startsWith(MODULE_WINDOW_PREFIX);
  } catch {
    return false;
  }
}

interface WinControlsProps {
  className?: string;
  /**
   * 为当前窗最大化按钮挂 Windows 11 Snap Layout 原生 overlay。
   * 同一 WebView 内同时只应有一个实例开启，避免重复 id。
   */
  enableSnapLayout?: boolean;
}

export function WinControls({ className, enableSnapLayout = false }: WinControlsProps) {
  const { t } = useI18n();
  const isMaximized = useTauriWindowMaximized();
  const maximizeRef = useRef<HTMLButtonElement>(null);
  const snapEnabled = Boolean(enableSnapLayout && isSnapLayoutEligibleWindow());

  useEffect(() => {
    if (!snapEnabled) return;
    const ac = new AbortController();
    void attachSnapMaximizeButton(maximizeRef.current, { signal: ac.signal });
    return () => {
      ac.abort();
    };
  }, [snapEnabled]);

  const handleMinimize = () => {
    if (!isTauriRuntime()) return;
    void getCurrentWindow()
      .minimize()
      .catch((e) => console.error("[WinControls] minimize failed", e));
  };

  const handleMaximize = () => {
    if (!isTauriRuntime()) return;
    // Snap overlay 会拦截点击并自行 maximize；此处保留为无 overlay 时的回退
    void getCurrentWindow()
      .toggleMaximize()
      .catch((e) => console.error("[WinControls] toggleMaximize failed", e));
  };

  const handleClose = () => {
    if (!isTauriRuntime()) return;
    void getCurrentWindow()
      .close()
      .catch((e) => console.error("[WinControls] close failed", e));
  };

  return (
    <div
      className={`win-controls${className ? ` ${className}` : ""}`}
      data-tauri-drag-region="false"
    >
      <button
        type="button"
        className="win-btn minimize"
        title={t("shell.topbar.minimize")}
        onClick={handleMinimize}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button
        ref={maximizeRef}
        type="button"
        id={snapEnabled ? OMNIPANEL_SNAP_MAXIMIZE_ID : undefined}
        className="win-btn maximize"
        title={isMaximized ? t("shell.topbar.restore") : t("shell.topbar.maximize")}
        onClick={handleMaximize}
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="0.5" y="0.5" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.2" />
            <rect x="4" y="4" width="5.5" height="5.5" fill="var(--bg)" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="win-btn close"
        title={t("shell.topbar.close")}
        onClick={handleClose}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );
}
