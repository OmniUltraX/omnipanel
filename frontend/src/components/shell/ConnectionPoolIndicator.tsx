import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import {
  poolKindLabelKey,
  useMergedPoolSummary,
  type PoolKind,
} from "../../stores/connectionPoolStore";

const VISIBLE_KINDS: PoolKind[] = ["ssh", "docker", "database", "redis", "protocol", "terminal"];

function ConnectionPoolPopover({
  anchorRect,
  onClose,
}: {
  anchorRect: DOMRect;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const summary = useMergedPoolSummary();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const left = Math.max(8, anchorRect.left);
  const bottom = window.innerHeight - anchorRect.top + 6;

  const rows = VISIBLE_KINDS.map((kind) => {
    const cat = summary.categories.find((c) => c.kind === kind);
    return {
      kind,
      active: cat?.active ?? 0,
      idle: cat?.idle ?? 0,
    };
  }).filter((row) => row.active > 0 || row.idle > 0);

  return createPortal(
    <div
      ref={ref}
      className="connection-pool-popover"
      style={{ left, bottom }}
      role="tooltip"
    >
      <div className="connection-pool-popover-title">{t("shell.connectionPool.detailTitle")}</div>
      {rows.length === 0 ? (
        <div className="connection-pool-popover-empty">{t("shell.connectionPool.empty")}</div>
      ) : (
        <ul className="connection-pool-popover-list">
          {rows.map((row) => (
            <li key={row.kind} className="connection-pool-popover-row">
              <span className="connection-pool-popover-kind">{t(poolKindLabelKey(row.kind))}</span>
              <span className="connection-pool-popover-counts">
                {t("shell.connectionPool.categoryCounts", {
                  active: row.active,
                  idle: row.idle,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}

/** 状态栏左侧：全局活跃 / 空闲连接数，悬停展示分类明细。 */
export function ConnectionPoolIndicator() {
  const { t } = useI18n();
  const summary = useMergedPoolSummary();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const handleEnter = useCallback(() => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setOpen(true), 200);
  }, [clearHoverTimer]);

  const handleLeave = useCallback(() => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setOpen(false), 150);
  }, [clearHoverTimer]);

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  const label = t("shell.connectionPool.summary", {
    active: summary.active,
    idle: summary.idle,
  });

  return (
    <>
      <span
        ref={anchorRef}
        className="statusbar-item connection-pool-indicator"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        title={label}
      >
        <span className="statusbar-dot green" aria-hidden />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          width="12"
          height="12"
          aria-hidden
        >
          <path d="M12 2a4 4 0 0 1 4 4v1h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1v5a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-5H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2V6a4 4 0 0 1 4-4z" />
          <circle cx="9" cy="13" r="1" fill="currentColor" stroke="none" />
          <circle cx="15" cy="13" r="1" fill="currentColor" stroke="none" />
        </svg>
        {label}
      </span>
      {open && anchorRef.current ? (
        <div onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
          <ConnectionPoolPopover
            anchorRect={anchorRef.current.getBoundingClientRect()}
            onClose={() => setOpen(false)}
          />
        </div>
      ) : null}
    </>
  );
}
