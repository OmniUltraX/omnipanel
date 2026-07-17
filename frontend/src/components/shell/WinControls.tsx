import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "../../i18n";
import { useTauriWindowMaximized } from "../../hooks/useTauriWindowMaximized";
import { isTauriRuntime } from "../../lib/isTauriRuntime";

interface WinControlsProps {
  className?: string;
}

export function WinControls({ className }: WinControlsProps) {
  const { t } = useI18n();
  const isMaximized = useTauriWindowMaximized();

  const handleMinimize = () => {
    if (!isTauriRuntime()) return;
    void getCurrentWindow()
      .minimize()
      .catch((e) => console.error("[WinControls] minimize failed", e));
  };

  const handleMaximize = () => {
    if (!isTauriRuntime()) return;
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
        type="button"
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
