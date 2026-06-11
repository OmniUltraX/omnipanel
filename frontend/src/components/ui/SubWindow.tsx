import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { Button } from "./Button";

export interface SubWindowProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 相对主窗口可视区域的宽度比例，默认 0.9 */
  widthRatio?: number;
  /** 相对主窗口可视区域的高度比例，默认 0.9 */
  heightRatio?: number;
  className?: string;
  /** 标题与关闭按钮之间的附加控件（如模型选择） */
  headerExtra?: ReactNode;
}

const DEFAULT_RATIO = 0.9;

export function SubWindow({
  open,
  title,
  onClose,
  children,
  widthRatio = DEFAULT_RATIO,
  heightRatio = DEFAULT_RATIO,
  className,
  headerExtra,
}: SubWindowProps) {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const panelClass = className ? `subwindow-panel ${className}` : "subwindow-panel";
  const widthPct = `${Math.min(1, Math.max(0.1, widthRatio)) * 100}%`;
  const heightPct = `${Math.min(1, Math.max(0.1, heightRatio)) * 100}%`;
  const closeLabel = t("shell.topbar.close");

  return createPortal(
    <div className="subwindow-overlay" role="presentation" onClick={onClose}>
      <div
        className={panelClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby="subwindow-title"
        style={{ width: widthPct, height: heightPct }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="subwindow-header">
          <h2 id="subwindow-title" className="subwindow-title">
            {title}
          </h2>
          {headerExtra ? (
            <div className="subwindow-header-extra">{headerExtra}</div>
          ) : null}
          <Button
            type="button"
            variant="icon"
            className="subwindow-close"
            title={closeLabel}
            aria-label={closeLabel}
            onClick={onClose}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              width="14"
              height="14"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </Button>
        </div>
        <div className="subwindow-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
