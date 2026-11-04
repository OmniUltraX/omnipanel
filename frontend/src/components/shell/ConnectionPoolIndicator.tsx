import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import {
  poolKindLabelKey,
  useMergedPoolSummary,
  type PoolKind,
} from "../../stores/connectionPoolStore";

const VISIBLE_KINDS: PoolKind[] = ["ssh", "docker", "database", "redis", "protocol", "terminal", "background"];

function poolTotal(active: number, idle: number): number {
  return active + idle;
}

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
    const active = cat?.active ?? 0;
    const idle = cat?.idle ?? 0;
    return {
      kind,
      active,
      total: poolTotal(active, idle),
    };
  }).filter((row) => row.active > 0 || row.total > 0);

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
                  total: row.total,
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

/** 状态栏左侧：活跃 / 总连接；无连接时不占位。 */
export function ConnectionPoolIndicator() {
  const { t } = useI18n();
  const summary = useMergedPoolSummary();
  const total = poolTotal(summary.active, summary.idle);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
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

  if (total <= 0 && summary.active <= 0) {
    return null;
  }

  const label = t("shell.connectionPool.summary", {
    active: summary.active,
    total,
  });
  const tone = summary.active > 0 ? "statusbar-chip--ok" : "statusbar-chip--muted";

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`statusbar-chip ${tone} connection-pool-indicator`}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        title={label}
        aria-label={label}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M6.5 3.5h3M4 6.5v3M12 6.5v3M6.5 12.5h3" strokeLinecap="round" />
          <rect x="5.5" y="5.5" width="5" height="5" rx="1" />
        </svg>
        <span className="statusbar-chip__label">{label}</span>
      </button>
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
