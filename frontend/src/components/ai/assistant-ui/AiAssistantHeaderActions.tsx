import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "../../ui/Button";
import { clampMenuPosition } from "../../../lib/contextMenuPosition";
import { useI18n } from "../../../i18n";
import { useUiFollowStore } from "../../../lib/ai/uiFollow";
import { useAiStore } from "../../../stores/aiStore";
import {
  useSettingsStore,
  type AiDisplayMode,
} from "../../../stores/settingsStore";
import { AiConversationList } from "./AiConversationList";
import { AiConversationTitle } from "./AiConversationTitle";

function ChevronIcon() {
  return (
    <svg
      className="ai-toolbar-chevron"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
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

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function toggleAiDisplayMode(mode: AiDisplayMode): AiDisplayMode {
  return mode === "dockview" ? "subwindow" : "dockview";
}

function useToolbarDropdown(menuMinWidth: number) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;

    const syncMenuPosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      const menuEl = menuRef.current;
      if (!rect) return;

      const measuredWidth = menuEl?.getBoundingClientRect().width ?? menuMinWidth;
      const measuredHeight = menuEl?.getBoundingClientRect().height ?? 0;
      const anchor = clampMenuPosition(
        { x: rect.left, y: rect.bottom + 4 },
        { width: Math.max(measuredWidth, menuMinWidth), height: measuredHeight },
      );

      setMenuPosition({
        top: anchor.y,
        left: anchor.x,
        minWidth: Math.max(measuredWidth, menuMinWidth),
      });
    };

    syncMenuPosition();
    window.addEventListener("resize", syncMenuPosition);
    window.addEventListener("scroll", syncMenuPosition, true);
    return () => {
      window.removeEventListener("resize", syncMenuPosition);
      window.removeEventListener("scroll", syncMenuPosition, true);
    };
  }, [open, menuMinWidth]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !wrapRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return {
    menuId,
    open,
    setOpen,
    menuPosition,
    wrapRef,
    buttonRef,
    menuRef,
  };
}

function ToolbarDropdownShell({
  open,
  menuId,
  menuPosition,
  menuRef,
  className,
  children,
}: {
  open: boolean;
  menuId: string;
  menuPosition: { top: number; left: number; minWidth: number } | null;
  menuRef: RefObject<HTMLDivElement | null>;
  className?: string;
  children: ReactNode;
}) {
  if (!open || !menuPosition) return null;
  return createPortal(
    <div
      id={menuId}
      role="menu"
      ref={menuRef}
      className={className}
      style={{
        position: "fixed",
        top: menuPosition.top,
        left: menuPosition.left,
        minWidth: menuPosition.minWidth,
        zIndex: 1200,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * 当前会话标题下拉：新建 + 历史切换（唯一会话入口）。
 * 不再单独放「会话列表」按钮，避免职责重叠。
 */
export function AiConversationSwitcher() {
  const { t } = useI18n();
  const isGenerating = useAiStore((s) => s.isGenerating);
  const createConversation = useAiStore((s) => s.createConversation);
  const {
    menuId,
    open,
    setOpen,
    menuPosition,
    wrapRef,
    buttonRef,
    menuRef,
  } = useToolbarDropdown(280);

  const handleCreate = useCallback(() => {
    createConversation();
    setOpen(false);
  }, [createConversation, setOpen]);

  return (
    <div className="ai-toolbar-dropdown" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`ai-toolbar-trigger ai-toolbar-trigger--title${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={t("ai.conversations.switcherHint")}
        onClick={() => setOpen((v) => !v)}
      >
        <AiConversationTitle as="div" className="ai-panel-toolbar-title" interactive={false} />
        <ChevronIcon />
      </button>
      <ToolbarDropdownShell
        open={open}
        menuId={menuId}
        menuPosition={menuPosition}
        menuRef={menuRef}
        className="ai-toolbar-menu ai-toolbar-menu--switcher"
      >
        <button
          type="button"
          role="menuitem"
          className="ai-toolbar-menu-item ai-toolbar-menu-item--accent"
          disabled={isGenerating}
          onClick={handleCreate}
        >
          <PlusIcon />
          <span>{t("ai.conversations.new")}</span>
        </button>
        <div className="ai-toolbar-menu-divider" />
        <div className="ai-toolbar-menu-sessions-body">
          <AiConversationList
            compact
            showCreateButton={false}
            onItemActivate={() => setOpen(false)}
          />
        </div>
      </ToolbarDropdownShell>
    </div>
  );
}

/** 跟随开关 */
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

/** @deprecated 会话列表入口已合并到标题下拉 */
export function AiConversationListToggle() {
  return null;
}

/** 右侧轻量操作：跟随 / 显示模式 */
export function AiPanelToolbarActions() {
  return (
    <div className="ai-panel-toolbar-actions" role="toolbar" aria-label="AI">
      <AiFollowToggle />
      <AiDisplayModeToggle />
    </div>
  );
}

/**
 * 内容层工具栏：标题下拉（新建+历史）+ 右侧轻量操作。
 */
export function AiPanelToolbar({ showTitle = true }: { showTitle?: boolean }) {
  return (
    <div className="ai-panel-toolbar">
      {showTitle ? (
        <AiConversationSwitcher />
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
