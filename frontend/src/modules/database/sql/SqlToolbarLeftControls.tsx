import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "../../../components/ui/primitives/Button";
import { Select } from "../../../components/ui/form/Select";
import {
  IconSettings,
  IconClock,
  IconStop,
  IconCheckCircle,
  IconXCircle,
} from "../../../components/ui/Icons";
import { useI18n } from "../../../i18n";
import {
  useSettingsStore,
  clampDatabaseQueryPageSize,
  clampSqlEditorFontSize,
  clampSqlEditorLineHeight,
  DATABASE_QUERY_PAGE_SIZE_OPTIONS,
  SQL_EDITOR_FONT_SIZE_OPTIONS,
  SQL_EDITOR_LINE_HEIGHT_OPTIONS,
} from "../../../stores/settingsStore";
import {
  clearSqlQueryHistory,
  listSqlQueryHistoryGrouped,
  type SqlQueryHistoryEntry,
} from "./sqlQueryHistoryStore";
import type { SqlHistoryKind } from "./classifySqlHistoryKind";

/** 设置/历史浮层；Select 下拉需高于此值，否则会被面板挡住 */
const SQL_TOOLBAR_POPOVER_Z_INDEX = 200000;
const SQL_TOOLBAR_SELECT_Z_INDEX = SQL_TOOLBAR_POPOVER_Z_INDEX + 10;

function AnchorPopover({
  anchorRef,
  open,
  onClose,
  children,
  className,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const el = panelRef.current;
    if (!anchor || !el) return;
    const rect = anchor.getBoundingClientRect();
    const { width } = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setCoords({ left, top: rect.bottom + 6 });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition, children]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      // Select 下拉挂到 body，点击选项时不应关掉设置面板
      if (t instanceof Element && t.closest(".omni-select-panel")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, onClose, anchorRef, updatePosition]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      className={className}
      style={{
        position: "fixed",
        left: coords?.left ?? -9999,
        top: coords?.top ?? -9999,
        zIndex: SQL_TOOLBAR_POPOVER_Z_INDEX,
        visibility: coords ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function HistoryList({
  scopeId,
  refreshKey,
}: {
  scopeId: string;
  refreshKey: number;
}) {
  const { t } = useI18n();
  const grouped = useMemo(() => listSqlQueryHistoryGrouped(scopeId), [scopeId, refreshKey]);
  const order: SqlHistoryKind[] = ["select", "dml", "ddl", "other"];
  const labels: Record<SqlHistoryKind, string> = {
    select: t("database.sqlToolbar.historyKindSelect"),
    dml: t("database.sqlToolbar.historyKindDml"),
    ddl: t("database.sqlToolbar.historyKindDdl"),
    other: t("database.sqlToolbar.historyKindOther"),
  };

  const total = order.reduce((n, k) => n + grouped[k].length, 0);
  if (total === 0) {
    return <div className="sql-toolbar-popover__empty">{t("database.sqlToolbar.historyEmpty")}</div>;
  }

  return (
    <div className="sql-toolbar-history">
      {order.map((kind) => {
        const items = grouped[kind];
        if (items.length === 0) return null;
        return (
          <div key={kind} className="sql-toolbar-history__group">
            <div className="sql-toolbar-history__group-title">
              {labels[kind]}
              <span className="sql-toolbar-history__count">{items.length}</span>
            </div>
            <ul className="sql-toolbar-history__list">
              {items.map((item: SqlQueryHistoryEntry) => (
                <li key={item.id} className="sql-toolbar-history__item">
                  <div className="sql-toolbar-history__meta">
                    <span>{formatTime(item.executedAt)}</span>
                    {item.elapsedMs != null ? <span>{item.elapsedMs}ms</span> : null}
                  </div>
                  <pre className="sql-toolbar-history__sql">{item.sql}</pre>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export interface SqlToolbarLeftControlsProps {
  historyScopeId: string;
  running: boolean;
  autoCommit: boolean;
  inTransaction: boolean;
  supportsManualTxn: boolean;
  onFormat: () => void;
  onCancel: () => void;
  onAutoCommitChange: (autoCommit: boolean) => void;
  onCommit: () => void;
  onRollback: () => void;
}

export function SqlToolbarLeftControls({
  historyScopeId,
  running,
  autoCommit,
  inTransaction,
  supportsManualTxn,
  onFormat,
  onCancel,
  onAutoCommitChange,
  onCommit,
  onRollback,
}: SqlToolbarLeftControlsProps) {
  const { t } = useI18n();
  const settingsAnchorRef = useRef<HTMLSpanElement>(null);
  const historyAnchorRef = useRef<HTMLSpanElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  const sqlKeywordCase = useSettingsStore((s) => s.sqlKeywordCase);
  const sqlEditorFontFamily = useSettingsStore((s) => s.sqlEditorFontFamily);
  const sqlEditorFontSize = useSettingsStore((s) => s.sqlEditorFontSize);
  const sqlEditorLineHeight = useSettingsStore((s) => s.sqlEditorLineHeight);
  const formatSqlOnSave = useSettingsStore((s) => s.formatSqlOnSave);
  const databaseQueryPageSize = useSettingsStore((s) => s.databaseQueryPageSize);
  const setDatabaseSettings = useSettingsStore((s) => s.setDatabaseSettings);

  const openHistory = () => {
    setSettingsOpen(false);
    setHistoryRefresh((n) => n + 1);
    setHistoryOpen(true);
  };

  return (
    <div className="sql-toolbar-left">
      <span ref={settingsAnchorRef} className="sql-toolbar-left__anchor">
        <Button
          variant="icon"
          title={t("database.sqlToolbar.settings")}
          aria-label={t("database.sqlToolbar.settings")}
          aria-expanded={settingsOpen}
          onClick={() => {
            setHistoryOpen(false);
            setSettingsOpen((v) => !v);
          }}
        >
          <IconSettings size={14} />
        </Button>
      </span>
      <span ref={historyAnchorRef} className="sql-toolbar-left__anchor">
        <Button
          variant="icon"
          title={t("database.sqlToolbar.history")}
          aria-label={t("database.sqlToolbar.history")}
          aria-expanded={historyOpen}
          onClick={openHistory}
        >
          <IconClock size={14} />
        </Button>
      </span>
      <Button
        variant="icon"
        className={autoCommit ? "sql-toolbar-txn is-on" : "sql-toolbar-txn is-off"}
        title={
          supportsManualTxn
            ? autoCommit
              ? t("database.sqlToolbar.autoCommitOn")
              : t("database.sqlToolbar.autoCommitOff")
            : t("database.sqlToolbar.autoCommitUnsupported")
        }
        aria-label={t("database.sqlToolbar.autoCommit")}
        aria-pressed={autoCommit}
        disabled={!supportsManualTxn || running}
        onClick={() => onAutoCommitChange(!autoCommit)}
      >
        <span className="sql-toolbar-txn__dot" aria-hidden />
        <span className="sql-toolbar-txn__label">{autoCommit ? "AC" : "TX"}</span>
      </Button>
      {!autoCommit ? (
        <>
          <Button
            variant="icon"
            title={t("database.sqlToolbar.commit")}
            aria-label={t("database.sqlToolbar.commit")}
            disabled={running || !inTransaction}
            onClick={onCommit}
          >
            <IconCheckCircle size={14} />
          </Button>
          <Button
            variant="icon"
            title={t("database.sqlToolbar.rollback")}
            aria-label={t("database.sqlToolbar.rollback")}
            disabled={running || !inTransaction}
            onClick={onRollback}
          >
            <IconXCircle size={14} />
          </Button>
        </>
      ) : null}
      <Button
        variant="icon"
        title={t("database.formatSqlFile")}
        aria-label={t("database.formatSqlFile")}
        disabled={running}
        onClick={onFormat}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="14" height="14" aria-hidden>
          <path d="M2 3.5h12" strokeLinecap="round" />
          <path d="M2 7h8" strokeLinecap="round" />
          <path d="M2 10.5h10" strokeLinecap="round" />
          <path d="M2 14h6" strokeLinecap="round" />
        </svg>
      </Button>
      <Button
        variant="icon"
        className="sql-toolbar-stop"
        title={t("database.cancelSql")}
        aria-label={t("database.cancelSql")}
        disabled={!running}
        onClick={onCancel}
      >
        <IconStop size={14} />
      </Button>

      <AnchorPopover
        anchorRef={settingsAnchorRef}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        className="sql-toolbar-popover sql-toolbar-popover--settings"
      >
        <div className="sql-toolbar-popover__title">{t("database.sqlToolbar.settingsTitle")}</div>
        <div className="sql-toolbar-popover__section">{t("database.sqlToolbar.settingsEditor")}</div>
        <label className="sql-toolbar-popover__field">
          <span>{t("database.sqlToolbar.keywordCase")}</span>
          <Select
            value={sqlKeywordCase}
            onChange={(v) => setDatabaseSettings({ sqlKeywordCase: v as "upper" | "lower" })}
            options={[
              { value: "upper", label: t("database.sqlToolbar.keywordUpper") },
              { value: "lower", label: t("database.sqlToolbar.keywordLower") },
            ]}
            panelZIndex={SQL_TOOLBAR_SELECT_Z_INDEX}
          />
        </label>
        <label className="sql-toolbar-popover__field">
          <span>{t("database.sqlToolbar.fontFamily")}</span>
          <input
            className="input"
            value={sqlEditorFontFamily}
            onChange={(e) => setDatabaseSettings({ sqlEditorFontFamily: e.target.value })}
          />
        </label>
        <label className="sql-toolbar-popover__field">
          <span>{t("database.sqlToolbar.fontSize")}</span>
          <Select
            value={String(sqlEditorFontSize)}
            onChange={(v) =>
              setDatabaseSettings({ sqlEditorFontSize: clampSqlEditorFontSize(Number(v)) })
            }
            options={SQL_EDITOR_FONT_SIZE_OPTIONS.map((n) => ({
              value: String(n),
              label: String(n),
            }))}
            panelZIndex={SQL_TOOLBAR_SELECT_Z_INDEX}
          />
        </label>
        <label className="sql-toolbar-popover__field">
          <span>{t("database.sqlToolbar.lineHeight")}</span>
          <Select
            value={String(sqlEditorLineHeight)}
            onChange={(v) =>
              setDatabaseSettings({ sqlEditorLineHeight: clampSqlEditorLineHeight(Number(v)) })
            }
            options={SQL_EDITOR_LINE_HEIGHT_OPTIONS.map((n) => ({
              value: String(n),
              label: String(n),
            }))}
            panelZIndex={SQL_TOOLBAR_SELECT_Z_INDEX}
          />
        </label>
        <label className="sql-toolbar-popover__check">
          <input
            type="checkbox"
            checked={formatSqlOnSave}
            onChange={(e) => setDatabaseSettings({ formatSqlOnSave: e.target.checked })}
          />
          <span>{t("database.sqlToolbar.formatOnSave")}</span>
        </label>
        <div className="sql-toolbar-popover__section">{t("database.sqlToolbar.settingsExec")}</div>
        <label className="sql-toolbar-popover__field">
          <span>{t("database.sqlToolbar.resultPageSize")}</span>
          <Select
            value={String(databaseQueryPageSize)}
            onChange={(v) =>
              setDatabaseSettings({
                databaseQueryPageSize: clampDatabaseQueryPageSize(Number(v)),
              })
            }
            options={DATABASE_QUERY_PAGE_SIZE_OPTIONS.map((n) => ({
              value: String(n),
              label: String(n),
            }))}
            panelZIndex={SQL_TOOLBAR_SELECT_Z_INDEX}
          />
        </label>
      </AnchorPopover>

      <AnchorPopover
        anchorRef={historyAnchorRef}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        className="sql-toolbar-popover sql-toolbar-popover--history"
      >
        <div className="sql-toolbar-popover__title-row">
          <div className="sql-toolbar-popover__title">{t("database.sqlToolbar.historyTitle")}</div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearSqlQueryHistory(historyScopeId);
              setHistoryRefresh((n) => n + 1);
            }}
          >
            {t("database.sqlToolbar.historyClear")}
          </Button>
        </div>
        <HistoryList scopeId={historyScopeId} refreshKey={historyRefresh} />
      </AnchorPopover>
    </div>
  );
}
