import { useAiStore } from "../../stores/aiStore";
import { useI18n } from "../../i18n";
import { formatModShortcut } from "../../lib/platform";
import { IconSparkles } from "../ui/icons/Icons";

/** 主窗顶栏 / 模块窗右上角共用的 AI 助手入口 */
export function AiChromeButton() {
  const { t } = useI18n();
  const drawerOpen = useAiStore((s) => s.drawerOpen);
  const label = t("shell.topbar.aiAssistant", { shortcut: formatModShortcut("`") });

  return (
    <button
      type="button"
      className={`dock-chrome-ai-btn drag-ignore${drawerOpen ? " is-active" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={drawerOpen}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        useAiStore.getState().toggleDrawer();
      }}
    >
      <IconSparkles size={14} />
    </button>
  );
}
