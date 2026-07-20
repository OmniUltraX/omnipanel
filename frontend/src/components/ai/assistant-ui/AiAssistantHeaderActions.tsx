import { Button } from "../../ui/Button";
import { useI18n } from "../../../i18n";
import { useUiFollowStore } from "../../../lib/ai/uiFollow";
import { useAiStore } from "../../../stores/aiStore";
import {
  useSettingsStore,
  type AiDisplayMode,
} from "../../../stores/settingsStore";
import { AiConversationTitle } from "./AiConversationTitle";

function ConversationListIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
      <path d="M8 7h.01" />
      <path d="M8 12h.01" />
      <path d="M8 17h.01" />
    </svg>
  );
}

function PopoutIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden
    >
      <rect x="2" y="2" width="9" height="9" rx="1" />
      <path d="M5 11v2.5A1.5 1.5 0 0 0 6.5 15H12a1 1 0 0 0 1-1V8.5A1.5 1.5 0 0 0 11.5 7H11" />
    </svg>
  );
}

function DockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden
    >
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <path d="M11 2v12" />
    </svg>
  );
}

function toggleAiDisplayMode(mode: AiDisplayMode): AiDisplayMode {
  return mode === "dockview" ? "subwindow" : "dockview";
}

/** 跟随开关（工具栏聚合入口） */
export function AiFollowToggle() {
  const { t } = useI18n();
  const followEnabled = useUiFollowStore((s) => s.followAiActions);
  const toggleFollow = useUiFollowStore((s) => s.toggleFollowAiActions);

  return (
    <Button
      variant="ghost"
      size="sm"
      className={`ai-toolbar-btn ai-follow-toggle${followEnabled ? " is-active" : ""}`}
      type="button"
      title={t("ai.follow.hint")}
      aria-label={t("ai.follow.hint")}
      aria-pressed={followEnabled}
      onClick={() => toggleFollow()}
    >
      {followEnabled ? t("ai.follow.on") : t("ai.follow.off")}
    </Button>
  );
}

/** Dock 边栏 ↔ 居中弹窗 */
export function AiDisplayModeToggle() {
  const { t } = useI18n();
  const mode = useSettingsStore((s) => s.aiDisplayMode);
  const setAiDisplayMode = useSettingsStore((s) => s.setAiDisplayMode);
  const openDrawer = useAiStore((s) => s.openDrawer);

  const label =
    mode === "dockview"
      ? t("ai.displayMode.toSubwindow")
      : t("ai.displayMode.toDock");

  return (
    <Button
      variant="ghost"
      size="sm"
      className="ai-toolbar-btn ai-toolbar-btn--icon"
      title={label}
      aria-label={label}
      onClick={() => {
        setAiDisplayMode(toggleAiDisplayMode(mode));
        openDrawer();
      }}
    >
      {mode === "dockview" ? <PopoutIcon /> : <DockIcon />}
    </Button>
  );
}

/** 会话列表折叠 */
export function AiConversationListToggle() {
  const { t } = useI18n();
  const conversationListOpen = useAiStore((s) => s.conversationListOpen);
  const toggleConversationList = useAiStore((s) => s.toggleConversationList);

  return (
    <Button
      variant="ghost"
      size="sm"
      className={`ai-toolbar-btn${conversationListOpen ? " is-active" : ""}`}
      title={t("ai.conversations.toggle")}
      aria-label={t("ai.conversations.toggle")}
      aria-pressed={conversationListOpen}
      onClick={toggleConversationList}
    >
      <ConversationListIcon />
      <span className="ai-toolbar-btn-label">{t("ai.conversations.toggle")}</span>
    </Button>
  );
}

/** 聚合操作：会话列表 / 跟随 / 显示模式 */
export function AiPanelToolbarActions() {
  return (
    <div className="ai-panel-toolbar-actions" role="toolbar" aria-label="AI">
      <AiConversationListToggle />
      <AiFollowToggle />
      <AiDisplayModeToggle />
    </div>
  );
}

/**
 * 内容层工具栏（在窗口 chrome 之下）：
 * 会话标题 + 聚合操作按钮。
 */
export function AiPanelToolbar({ showTitle = true }: { showTitle?: boolean }) {
  return (
    <div className="ai-panel-toolbar">
      {showTitle ? (
        <AiConversationTitle as="h3" className="ai-panel-toolbar-title" />
      ) : (
        <div className="ai-panel-toolbar-spacer" />
      )}
      <AiPanelToolbarActions />
    </div>
  );
}

/** SubWindow 标题栏附加：聚合操作（标题已在 SubWindow title） */
export function AiAssistantHeaderToolbar() {
  return (
    <div className="ai-subwindow-header-extra">
      <AiPanelToolbarActions />
    </div>
  );
}
