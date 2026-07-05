import { useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import {
  getMinimizedSubWindows,
  subscribeMinimizedSubWindows,
} from "../../../lib/subWindowMinimizedRegistry";

function MinimizedWindowIcon() {
  return (
    <svg
      className="subwindow-minimized-bar__icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      width="14"
      height="14"
      aria-hidden
    >
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.2" />
      <path d="M2.5 6.5h11" strokeLinecap="round" />
    </svg>
  );
}

/** 右下角垂直堆叠的最小化 SubWindow 任务�?*/
export function SubWindowMinimizedStack() {
  const { t } = useI18n();
  const [, tick] = useState(0);

  useEffect(() => subscribeMinimizedSubWindows(() => tick((value) => value + 1)), []);

  const items = getMinimizedSubWindows();
  if (items.length === 0) return null;

  const restoreLabel = t("shell.topbar.restore");
  const closeLabel = t("shell.topbar.close");

  return createPortal(
    <div className="subwindow-minimized-stack" role="list" aria-label={restoreLabel}>
      {items.map((item) => (
        <div key={item.id} className="subwindow-minimized-bar" role="listitem">
          <button
            type="button"
            className="subwindow-minimized-bar__restore"
            onClick={item.onRestore}
            title={item.title}
            aria-label={`${restoreLabel}: ${item.title}`}
          >
            <MinimizedWindowIcon />
            <span className="subwindow-minimized-bar__label">{item.title}</span>
          </button>
          <button
            type="button"
            className="subwindow-minimized-bar__close drag-ignore"
            title={closeLabel}
            aria-label={`${closeLabel}: ${item.title}`}
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              item.onClose();
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
