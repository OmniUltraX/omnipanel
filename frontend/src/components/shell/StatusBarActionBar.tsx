import { useCallback, useEffect, useRef, useState } from "react";
import {
  getStatusBarActionBarContent,
  getStatusBarActionBarMeta,
  useStatusBarActionBarRegistryRev,
} from "../../hooks/useStatusBarActionBar";
import { useStatusBarActionBarStore } from "../../stores/statusBarActionBarStore";
import { resolveStatusBarPanelTypeLabel } from "../../lib/statusBarPanelTypeLabel";
import { useI18n } from "../../i18n";
import { StatusBarPanelPopover } from "./StatusBarPanelPopover";

/**
 * 状态栏右侧 ActionBar：根据当前激活的 dock panel 展示对应面板的独有配置/操作。
 * 点击触发按钮在状态栏上方弹出 Popover；各面板通过 `useStatusBarActionBar` 注册内容。
 */
export function StatusBarActionBar() {
  const { t } = useI18n();
  const activePanelId = useStatusBarActionBarStore(
    (state) => state.activeDock?.panelId ?? null,
  );
  const panelType = useStatusBarActionBarStore(
    (state) => state.activeDock?.panelType ?? null,
  );
  useStatusBarActionBarRegistryRev();

  const content = getStatusBarActionBarContent(activePanelId);
  const meta = getStatusBarActionBarMeta(activePanelId);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOpen(false);
  }, [activePanelId]);

  const toggleOpen = useCallback(() => {
    setOpen((value) => !value);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  if (!content) return null;

  const typeLabel = resolveStatusBarPanelTypeLabel(panelType, t);
  const triggerLabel = meta.triggerLabel ?? typeLabel;
  const summary = meta.summary?.trim();
  const displayLabel = summary ? `${triggerLabel} · ${summary}` : triggerLabel;
  const popoverTitle = triggerLabel;

  return (
    <div
      className="statusbar-action-bar"
      data-panel-id={activePanelId ?? undefined}
      data-panel-type={panelType ?? undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`statusbar-item statusbar-button statusbar-action-bar__trigger${open ? " statusbar-button--active" : ""}`}
        onClick={toggleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={displayLabel}
      >
        <span className="statusbar-button-label">{displayLabel}</span>
        <svg
          className="statusbar-button-chevron statusbar-action-bar__chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          width="10"
          height="10"
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <StatusBarPanelPopover
        anchorRef={triggerRef}
        open={open}
        onClose={handleClose}
        title={popoverTitle}
        placement="above"
      >
        <div className="statusbar-action-bar-popover-body">{content}</div>
      </StatusBarPanelPopover>
    </div>
  );
}
