import { useAiStore } from "../../stores/aiStore";
import { useI18n } from "../../i18n";

/** Dock 右上角窗口控制旁的 AI 助手入口 */
export function AiChromeButton() {
  const { t } = useI18n();
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const label = t("shell.topbar.aiAssistant", { shortcut: "Ctrl+`" });

  return (
    <button
      type="button"
      className={`dock-chrome-ai-btn drag-ignore${drawerOpen ? " is-active" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={drawerOpen}
      onClick={() => useAiStore.getState().toggleDrawer()}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14" aria-hidden>
        <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
        <circle cx="18" cy="14" r="0.5" fill="currentColor" />
        <circle cx="6" cy="14" r="0.5" fill="currentColor" />
        <path d="M12 17v4M8 21h8" />
      </svg>
    </button>
  );
}
